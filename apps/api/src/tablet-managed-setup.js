import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { hasLiveBankingCredential } from './auth/password-change.js';
import { ownerCalaiTabletAuthorityMatches } from './business-product-policy.js';
import { withTransaction } from './db/index.js';
import { exactObject, HttpError, readJson, sendJson } from './http.js';
import { assertTabletSelectionActivation } from './tablet-assignment-safety.js';
import { assertFleetNewEnrolmentAllowed } from './tablet-fleet-policy.js';
import { createTabletManagedSetupGraph } from './tablet-managed-setup-graph.js';
import { buildManagedTerminalInstaller } from '../../terminal-auth/windows/build-installer.mjs';

const lifetimeMs = 72 * 60 * 60_000;
const challengeMs = 5 * 60_000;
const evidenceMs = 5 * 60_000;
const leaseMs = 4 * 60_000;
const checkMs = 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const challengeFormat = /^[A-Za-z0-9_-]{43}$/;
const pending = new Set(['pending', 'assigned', 'verified']);
const getJob = (db, jobId) => db.prepare('SELECT * FROM tablet_managed_setups WHERE id=?').get(jobId);
const closed = () => new HttpError(410, 'MANAGED_SETUP_CLOSED', 'This managed tablet setup is no longer active.');
const noStore = { 'Cache-Control': 'no-store' };
const at = (config, offset = 0) => new Date(config.now().getTime() + offset).toISOString();

export function tabletManagedTarget(config, { intuneManagedDeviceId, entraDeviceId, serialNumber }) {
  const settings = config.tabletManagedSetup;
  if (!settings?.enabled) return null;
  const target = settings.targets.get(intuneManagedDeviceId);
  return target?.entraDeviceId === entraDeviceId && target?.serialNumber === serialNumber?.toUpperCase() ? target : null;
}

function targetForRow(config, row) {
  return tabletManagedTarget(config, {
    intuneManagedDeviceId: row.intune_managed_device_id,
    entraDeviceId: row.entra_device_id,
    serialNumber: row.serial_number
  });
}

const eatsLink = (db, businessId) => db.prepare("SELECT 1 FROM business_product_links WHERE business_id=? AND product='cal-eats'").get(businessId);

function available(db, config, row) {
  if (!row?.business_id || row.archived_at || row.disabled_at || row.authority_blocked_at || row.handoff_requested_at || row.lifecycle_state !== 'assigned') return null;
  const target = targetForRow(config, row);
  if (!target) return null;
  const business = db.prepare(`SELECT 1 FROM business_accounts b WHERE b.id=? AND b.archived_at IS NULL AND (
    EXISTS(SELECT 1 FROM business_product_links p JOIN restaurants r ON r.id=p.restaurant_id AND r.archived_at IS NULL
      WHERE p.business_id=b.id AND p.product='cal-eats') OR
    (?='calai' AND NOT EXISTS(SELECT 1 FROM business_product_links p WHERE p.business_id=b.id AND p.product='cal-eats')
      AND EXISTS(SELECT 1 FROM business_product_links p WHERE p.business_id=b.id AND p.product='calai' AND p.status='active'))
  )`).get(row.business_id, row.application_products);
  return business ? target : null;
}

export function tabletManagedSetupState(db, config, row) {
  const job = db.prepare('SELECT id,state,expires_at,requested_at FROM tablet_managed_setups WHERE tablet_id=?').get(row.id);
  const enabled = Boolean(available(db, config, row));
  let state = null;
  if (job) {
    if (job.state === 'registered') state = row.terminal_id === job.id && hasRegistration(db, row.business_id) && !row.authority_blocked_at ? 'registered' : 'attention';
    else if (!enabled || job.expires_at <= at(config) || job.state === 'attention') state = 'attention';
    else state = job.state === 'pending' ? 'waiting' : 'in_progress';
  }
  return { available: enabled, state, requestedAt: job?.requested_at ?? null,
    ...(enabled && !job && !row.terminal_id && !eatsLink(db, row.business_id) ? { requiresOwnerApproval: true } : {}) };
}

// Used only inside the authenticated selected business context. It schedules a
// local discovery read on an already allowed Windows browser, with no authority.
export function managedTabletAwaitingBrowser(db, config, businessId) {
  if (!config.tabletManagedSetup?.enabled) return false;
  return Boolean(db.prepare(`SELECT 1 FROM tablet_managed_setups s JOIN admin_tablets t ON t.id=s.tablet_id
    WHERE s.business_id=? AND t.business_id=s.business_id AND s.expires_at>? AND t.lifecycle_state='assigned'
    AND t.authority_blocked_at IS NULL AND t.archived_at IS NULL AND (
      (s.state IN('pending','assigned','verified') AND t.terminal_id IS NULL AND t.revision=s.record_revision) OR
      (s.state='registered' AND t.terminal_id=s.id AND EXISTS(SELECT 1 FROM business_terminals x WHERE x.id=s.id AND x.revoked_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM tablet_application_receipts r WHERE r.tablet_id=t.id AND r.terminal_id=s.id AND r.record_revision=t.revision))
    ) LIMIT 1`).get(businessId, at(config)));
}

export function assertNoManagedBusinessSetup(db, config, businessId) {
  if (db.prepare(`SELECT 1 FROM tablet_managed_setups WHERE business_id=? AND expires_at>?
    AND state IN('pending','assigned','verified')`).get(businessId, at(config))) {
    throw new HttpError(409, 'MANAGED_SETUP_PENDING', 'This location already has a managed tablet setup in progress.');
  }
}

function hasRegistration(db, businessId) {
  return db.prepare('SELECT 1 FROM business_terminals WHERE business_id=? AND revoked_at IS NULL').get(businessId);
}

function sameAssignment(job, row, target) {
  return target && row.business_id === job.business_id && row.serial_number === job.serial_number &&
    row.intune_managed_device_id === job.managed_device_id && row.entra_device_id === job.entra_device_id &&
    target.groupId === job.group_id && target.directoryObjectId === job.directory_object_id;
}

// Called from the authorised fleet Save transaction. Superseding a displayed choice
// for the same exact tablet does not dispatch a second script or create a new key.
export function queueTabletManagedSetup(db, config, row, actorId, { calaiOwnerBinding = null } = {}) {
  const target = available(db, config, row);
  if (!target || row.terminal_id) return false;
  const stamp = at(config);
  const existing = db.prepare('SELECT * FROM tablet_managed_setups WHERE tablet_id=?').get(row.id);
  if (!eatsLink(db, row.business_id)) {
    const binding = calaiOwnerBinding ?? existing?.calai_owner_binding;
    if (!binding) return false;
    if (row.application_products !== 'calai' || !ownerCalaiTabletAuthorityMatches(db, row.business_id,
      calaiOwnerBinding ? actorId : existing.requested_by, row, JSON.parse(binding))) {
      throw new HttpError(409, 'CALAI_AUTHORITY_REQUIRED', 'The verified Calai owner must approve this tablet.');
    }
    if (!calaiOwnerBinding) actorId = existing.requested_by;
    calaiOwnerBinding = binding;
  }
  if (existing) {
    if (!sameAssignment(existing, row, target) || existing.state === 'registered') {
      throw new HttpError(409, 'MANAGED_SETUP_CHANGED', 'Review this tablet’s existing setup before changing its assignment.');
    }
    if (pending.has(existing.state) && existing.expires_at > stamp) {
      db.prepare('UPDATE tablet_managed_setups SET record_revision=?,requested_by=?,calai_owner_binding=? WHERE id=?').run(row.revision, actorId, calaiOwnerBinding, existing.id);
      return true;
    }
  }
  assertFleetNewEnrolmentAllowed(db, row.business_id);
  assertNoManagedBusinessSetup(db, config, row.business_id);
  if (hasRegistration(db, row.business_id)) throw new HttpError(409, 'TERMINAL_ALREADY_REGISTERED', 'This location already has a registered tablet.');
  if (db.prepare('SELECT 1 FROM business_terminal_pairings WHERE business_id=? AND consumed_at IS NULL AND expires_at>?').get(row.business_id, stamp)) {
    throw new HttpError(409, 'TABLET_SETUP_PENDING', 'An existing private tablet setup must finish or expire before starting the managed connection.');
  }
  db.prepare(`UPDATE tablet_managed_setups SET state='attention',failure_code='expired' WHERE business_id=? AND expires_at<=?
    AND state IN('pending','assigned','verified')`).run(row.business_id, stamp);
  if (existing) {
    db.prepare(`UPDATE tablet_managed_setups SET record_revision=?,requested_by=?,calai_owner_binding=?,expires_at=?,next_check_at=?,
      state=CASE WHEN script_id IS NULL THEN 'pending' ELSE 'assigned' END,
      verified_at=NULL,challenge=NULL,challenge_until=NULL,
      lease_id=NULL,lease_until=NULL,failure_code=NULL WHERE id=?`)
      .run(row.revision, actorId, calaiOwnerBinding, at(config, lifetimeMs), stamp, existing.id);
    db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), actorId, 'tablet_fleet', row.id, 'tablet_managed_connection_retried', JSON.stringify({ jobId: existing.id, businessId: row.business_id }), stamp);
    return true;
  }
  const id = randomUUID();
  const builder = config.tabletManagedSetup.buildInstaller ?? buildManagedTerminalInstaller;
  const script = builder({ targetSerial: row.serial_number, entraDeviceId: row.entra_device_id, jobId: id });
  db.prepare(`INSERT INTO tablet_managed_setups(id,tablet_id,record_revision,business_id,requested_by,calai_owner_binding,managed_device_id,
    entra_device_id,serial_number,group_id,directory_object_id,script_content,requested_at,expires_at,next_check_at,state)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(id, row.id, row.revision, row.business_id, actorId, calaiOwnerBinding, row.intune_managed_device_id,
    row.entra_device_id, row.serial_number, target.groupId, target.directoryObjectId, script, stamp, at(config, lifetimeMs), stamp);
  db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), actorId, 'tablet_fleet', row.id, 'tablet_managed_connection_requested', JSON.stringify({ jobId: id, businessId: row.business_id }), stamp);
  return true;
}

function currentAssignment(db, config, job, { registered = false, allowWaiting = false } = {}) {
  const row = db.prepare('SELECT * FROM admin_tablets WHERE id=?').get(job.tablet_id);
  const target = available(db, config, row);
  if (!sameAssignment(job, row, target)) throw closed();
  if (registered) {
    if (row.terminal_id !== job.id || !db.prepare('SELECT 1 FROM business_terminals WHERE id=? AND business_id=? AND revoked_at IS NULL').get(job.id, job.business_id)) throw closed();
    return row;
  }
  if (row.terminal_id || hasRegistration(db, job.business_id)) throw closed();
  const readinessChanged = () => {
    if (allowWaiting) return null;
    throw closed();
  };
  if (row.revision !== job.record_revision) return readinessChanged();
  const hasEats = eatsLink(db, job.business_id);
  if (job.calai_owner_binding) {
    if (hasEats || row.application_products !== 'calai' ||
        !ownerCalaiTabletAuthorityMatches(db, job.business_id, job.requested_by, row, JSON.parse(job.calai_owner_binding))) return readinessChanged();
  } else if (!hasEats || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND principal_kind='human' AND account_enabled=1").get(job.requested_by) ||
      !hasLiveBankingCredential(db, job.requested_by)) return readinessChanged();
  try {
    assertFleetNewEnrolmentAllowed(db, job.business_id);
    assertTabletSelectionActivation(db, config, job.business_id, row.application_products);
  } catch (error) {
    if (error instanceof HttpError) return readinessChanged();
    throw error;
  }
  return row;
}

function readKey(spki) {
  if (typeof spki !== 'string' || spki.length > 200) return null;
  try {
    const bytes = Buffer.from(spki, 'base64');
    if (bytes.toString('base64') !== spki) return null;
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1' || !key.export({ format: 'der', type: 'spki' }).equals(bytes)) return null;
    return { key, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch { return null; }
}

function validSignature(key, input, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  const bytes = Buffer.from(signature, 'base64url');
  return bytes.length === 64 && bytes.toString('base64url') === signature &&
    verify('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }, bytes);
}

function verifiedRunKey(job, result, now) {
  const reportTime = Date.parse(result.observedAt), createdAt = Date.parse(job.create_started_at);
  if (!Number.isFinite(reportTime) || !Number.isFinite(createdAt) || reportTime < createdAt || reportTime > now + 60_000) return null;
  const match = /^CAL_EATS_MANAGED_SETUP_V1:([A-Za-z0-9_-]{1,1024})$/.exec(result.resultMessage);
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) return null;
    const report = JSON.parse(bytes.toString('utf8'));
    exactObject(report, ['jobId', 'publicKeySpki', 'signature']);
    if (report.jobId !== job.id) return null;
    const key = readKey(report.publicKeySpki);
    return key && validSignature(key.key, `Cal-Eats managed terminal evidence v1\n${job.id}\n${report.publicKeySpki}`, report.signature) ? key.sha256 : null;
  } catch { return null; }
}

function closeJob(db, jobId, code) {
  db.prepare(`UPDATE tablet_managed_setups SET state='attention',failure_code=?,lease_id=NULL,lease_until=NULL,
    challenge=NULL,challenge_until=NULL WHERE id=? AND state IN('pending','assigned','verified')`).run(code, jobId);
}

// Worker commits its creation intent immediately before the external POST. After an
// interrupted POST, the Graph adapter may reconcile an exact existing script only.
export async function runTabletManagedSetup(db, config, { graph, limit = 2 } = {}) {
  if (!config.tabletManagedSetup?.enabled) return;
  const adapter = graph ?? createTabletManagedSetupGraph(config.tabletManagedSetup);
  const expired = db.prepare("SELECT id FROM tablet_managed_setups WHERE state IN('pending','assigned','verified') AND expires_at<=?").all(at(config));
  for (const row of expired) closeJob(db, row.id, 'expired');

  for (let index = 0; index < limit; index += 1) {
    const lease = randomUUID();
    const job = withTransaction(db, () => {
      const row = db.prepare(`SELECT * FROM tablet_managed_setups WHERE state IN('pending','assigned','verified') AND next_check_at<=?
        AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_check_at,id LIMIT 1`).get(at(config), at(config));
      if (!row) return null;
      db.prepare('UPDATE tablet_managed_setups SET lease_id=?,lease_until=? WHERE id=?').run(lease, at(config, leaseMs), row.id);
      return row;
    });
    if (!job) return;
    const request = { jobId: job.id, managedDeviceId: job.managed_device_id, entraDeviceId: job.entra_device_id,
      serialNumber: job.serial_number, scriptContent: job.script_content };
    const assertLease = () => {
      const current = getJob(db, job.id);
      if (current.lease_id !== lease || current.lease_until <= at(config) || current.expires_at <= at(config) || !pending.has(current.state)) throw closed();
      currentAssignment(db, config, current);
    };
    try {
      assertLease();
      if (!job.script_id) {
        const result = await adapter.dispatch({ ...request, allowCreate: !job.create_started_at,
          beforeAssign: () => { assertLease(); return true; },
          beginCreate: () => withTransaction(db, () => {
            assertLease();
            return db.prepare('UPDATE tablet_managed_setups SET create_started_at=? WHERE id=? AND create_started_at IS NULL').run(at(config), job.id).changes === 1;
          })
        });
        assertLease();
        if (!uuid.test(result?.scriptId ?? '')) throw new Error('Invalid managed script reference');
        db.prepare("UPDATE tablet_managed_setups SET state='assigned',script_id=? WHERE id=? AND lease_id=?").run(result.scriptId, job.id, lease);
      } else {
        const active = getJob(db, job.id);
        const result = await adapter.observe({ ...request, scriptId: active.script_id, requestedAt: active.create_started_at });
        assertLease();
        if (result) {
          const keyHash = verifiedRunKey(active, result, config.now().getTime());
          if (!keyHash || active.verified_key_hash && active.verified_key_hash !== keyHash) closeJob(db, job.id, 'invalid_evidence');
          else db.prepare("UPDATE tablet_managed_setups SET state='verified',verified_key_hash=?,verified_at=? WHERE id=? AND lease_id=?")
            .run(keyHash, at(config), job.id, lease);
        } else if (active.state === 'verified') {
          db.prepare('UPDATE tablet_managed_setups SET verified_at=NULL WHERE id=? AND lease_id=?').run(job.id, lease);
        }
      }
    } catch (error) {
      // A later worker may own the lease. An old network response never closes it.
      if (getJob(db, job.id)?.lease_id === lease && (error instanceof HttpError || error?.retry === false)) closeJob(db, job.id, 'connection_check_failed');
    } finally {
      db.prepare('UPDATE tablet_managed_setups SET lease_id=NULL,lease_until=NULL,next_check_at=? WHERE id=? AND lease_id=?').run(at(config, checkMs), job.id, lease);
    }
  }
}

export async function routeManagedTabletSetup({ req, res, url, db, config, checkRate }, registerTerminal) {
  if (req.method !== 'POST' || url.pathname !== '/api/terminal-devices/managed-enrolment') return false;
  if (!config.tabletManagedSetup?.enabled) throw new HttpError(503, 'MANAGED_SETUP_DISABLED', 'Managed tablet setup is unavailable.');
  const body = await readJson(req, Math.min(4096, config.bodyLimit));
  exactObject(body, ['jobId', 'publicKeySpki', 'challenge', 'signature']);
  const finishing = Object.hasOwn(body, 'signature') || Object.hasOwn(body, 'challenge');
  if (typeof body.jobId !== 'string' || !uuid.test(body.jobId)) throw closed();
  // Rate-limit each transport source, not the public job alone. An unrelated
  // caller cannot consume the tablet's challenge attempts or reserve a key.
  checkRate?.(req, 'managed-tablet-setup');
  const key = readKey(body.publicKeySpki);
  if (!key) throw new HttpError(400, 'TERMINAL_KEY_INVALID', 'A valid restaurant tablet public key is required.');
  const result = withTransaction(db, () => {
    const job = getJob(db, body.jobId);
    if (!job) throw closed();
    const registered = job.state === 'registered';
    const row = currentAssignment(db, config, job, { registered, allowWaiting: true });
    if (!row || (!registered && (job.state !== 'verified' || job.expires_at <= at(config) || !job.verified_at || job.verified_at <= at(config, -evidenceMs))) || job.verified_key_hash !== key.sha256) {
      return { status: 202, data: { status: 'waiting' } };
    }
    if (!finishing) {
      const challenge = job.challenge && job.challenge_until > at(config) ? job.challenge : randomBytes(32).toString('base64url');
      if (challenge !== job.challenge) db.prepare('UPDATE tablet_managed_setups SET challenge=?,challenge_until=? WHERE id=?').run(challenge, at(config, challengeMs), job.id);
      return { status: 200, data: { challenge } };
    }
    if (typeof body.challenge !== 'string' || !challengeFormat.test(body.challenge) || body.challenge !== job.challenge ||
        job.challenge_until <= at(config) || !validSignature(key.key,
          `Cal-Eats managed terminal activation v1\n${job.id}\n${body.challenge}\n${body.publicKeySpki}`, body.signature)) {
      throw new HttpError(409, 'MANAGED_SETUP_CHALLENGE_INVALID', 'Request a current tablet verification challenge.');
    }
    if (registered) return { status: 201, data: { paired: true, terminalId: job.id, businessId: job.business_id, registeredAt: job.registered_at } };

    const stamp = at(config);
    registerTerminal({ terminalId: job.id, businessId: job.business_id, actorId: job.requested_by,
      deviceName: row.display_name.slice(0, 80), publicKeySpki: body.publicKeySpki, keyHash: key.sha256, stamp, calaiOwnerBinding: job.calai_owner_binding });
    db.prepare('UPDATE admin_tablets SET terminal_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .run(job.id, stamp, row.id, row.revision);
    db.prepare("UPDATE tablet_managed_setups SET state='registered',registered_at=? WHERE id=?").run(stamp, job.id);
    db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), job.requested_by, 'tablet_fleet', row.id, 'tablet_managed_connection_registered', JSON.stringify({ terminalId: job.id, businessId: job.business_id, source: 'intune_execution_and_device_key' }), stamp);
    return { status: 201, data: { paired: true, terminalId: job.id, businessId: job.business_id, registeredAt: stamp } };
  });
  return sendJson(res, result.status, { data: result.data }, noStore);
}
