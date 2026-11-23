import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { businessFixture } from './unified-business-test-fixture.js';
import { routeBusinessTerminals } from '../src/business-terminals.js';
import { pairingCanonical, requestCanonical } from '../../terminal-auth/src/protocol.js';

async function fixture(t) {
  const f = await businessFixture();
  t.after(() => f.close());
  f.config.origin = 'https://eats.calai.info';
  t.mock.method(Date, 'now', () => f.config.now().getTime());
  const business = await f.registerSource({ allowed: true });
  const signed = await f.sourceLogin();
  assert.equal(signed.status, 200, signed.text);
  const owner = f.responseSession(signed);
  const cookie = signed.headers['Set-Cookie'].split(';')[0];

  function assigned(businessId) {
    const tabletId = randomUUID(), serialNumber = `SYNTHETIC-${tabletId.slice(0, 8)}`;
    const device = { intuneManagedDeviceId: randomUUID(), entraDeviceId: randomUUID(), serialNumber };
    const stamp = f.config.now().toISOString();
    f.db.prepare(`INSERT INTO admin_tablets(id,display_name,serial_number,business_id,intune_managed_device_id,
      entra_device_id,lifecycle_state,created_by,created_at,updated_at,application_products)
      VALUES(?,?,?,?,?,?,'assigned',?,?,?,'calai')`).run(tabletId, 'Assigned Surface', serialNumber,
      businessId, device.intuneManagedDeviceId, device.entraDeviceId, f.admin.id, stamp, stamp);
    return { tabletId, tabletName: 'Assigned Surface', serialNumber, revision: 1, device };
  }
  const tablet = assigned(business.id), unrelated = assigned(f.business.id);
  const items = [tablet.device, unrelated.device];
  const endpoint = `/api/business/accounts/${business.id}/terminals/calai-first-setup`;

  async function setup({ body, session = owner, directoryReader = async () => ({ items }) } = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method: body ? 'POST' : 'GET', url: endpoint, headers: { 'content-type': 'application/json' } });
    let response;
    const res = {
      writeHead(status, headers) { response = { status, headers }; },
      end(value) { response.payload = String(value ?? ''); }
    };
    try {
      await routeBusinessTerminals({ req, res, url: new URL(endpoint, f.config.origin), db: f.db,
        config: f.config, session, directoryReader });
    } catch (error) {
      return { status: error.status, code: error.code };
    }
    return response;
  }
  const setupBody = { tabletId: tablet.tabletId, expectedRevision: tablet.revision };
  const demoteOwner = () => f.db.prepare("UPDATE business_account_memberships SET permission='staff',membership_source='master' WHERE user_id=? AND business_id=?").run(owner.user.id, business.id);
  return { ...f, business, owner, cookie, tablet, unrelated, endpoint, setup, setupBody, demoteOwner };
}

function packageProof(result, tablet) {
  assert.equal(result.status, 200, result.code);
  assert.equal(result.headers['Content-Type'], 'application/octet-stream');
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.match(result.headers['Content-Disposition'], /CalEats-Tablet-Setup\.ps1/);
  assert.ok(result.payload.includes(`$TerminalBoundSerial='${tablet.serialNumber}'`));
  const embedded = result.payload.match(/\$TerminalEmbeddedEnrolmentBase64='([^']+)'/)?.[1];
  assert.ok(embedded);
  return JSON.parse(Buffer.from(embedded, 'base64').toString('utf8'));
}

function signedTablet(f, pairing) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signature = canonical => sign('sha256', Buffer.from(canonical), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const { terminalId, code } = pairing;
  const pair = () => f.json('/api/terminal-devices/pair', { method: 'POST', body: { terminalId, code,
    deviceName: 'Synthetic signed tablet', publicKeySpki, challengeSignature: signature(pairingCanonical({ ...pairing, publicKeySpki })) } });
  const request = (target, { token, method = 'GET', body } = {}) => {
    const nonce = randomBytes(24).toString('base64url'), timestamp = String(f.config.now().getTime());
    return f.json(target, { method, body, headers: {
      'X-Cal-Eats-Terminal-Id': terminalId,
      'X-Cal-Eats-Terminal-Timestamp': timestamp,
      'X-Cal-Eats-Terminal-Nonce': nonce,
      'X-Cal-Eats-Terminal-Signature': signature(requestCanonical({ terminalId, nonce, timestamp, method, target,
        body: body === undefined ? '' : JSON.stringify(body) })),
      ...(token ? { 'X-Cal-Eats-Terminal-Session': token } : {})
    } });
  };
  return { pair, request };
}

test('Calai owner first setup lists only exact managed assignments and rechecks authority, identity and revision before issuance', async t => {
  const f = await fixture(t);
  assert.equal((await f.setup({ session: f.adminSession })).status, 403);
  assert.equal((await f.setup({ session: f.otherSession })).status, 404);
  assert.equal((await f.setup({ session: { ...f.owner, nativeAudience: 'business' } })).status, 403);
  const result = await f.setup();
  assert.equal(result.status, 200);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
  assert.deepEqual(JSON.parse(result.payload).data, { eligible: true, tablets: [{
    tabletId: f.tablet.tabletId, tabletName: f.tablet.tabletName, serialNumber: f.tablet.serialNumber, revision: 1
  }] });
  const wrongSerial = async () => ({ items: [{ ...f.tablet.device, serialNumber: 'OTHER-SERIAL' }] });
  assert.deepEqual(JSON.parse((await f.setup({ directoryReader: wrongSerial })).payload).data.tablets, []);
  assert.equal((await f.setup({ body: f.setupBody, directoryReader: wrongSerial })).status, 409);
  assert.equal((await f.setup({ body: { ...f.setupBody, tabletId: f.unrelated.tabletId } })).status, 409);
  assert.equal((await f.setup({ body: { ...f.setupBody, serialNumber: f.tablet.serialNumber } })).status, 400);
  const generic = await f.json(f.endpoint.replace('calai-first-setup', 'setup'), { method: 'POST', cookie: f.cookie, body: {} });
  assert.equal(generic.body.error.code, 'CALAI_ASSIGNED_SETUP_REQUIRED');
  const changed = await f.setup({ body: f.setupBody, directoryReader: async () => {
    f.db.prepare('UPDATE admin_tablets SET revision=revision+1 WHERE id=?').run(f.tablet.tabletId);
    return { items: [f.tablet.device] };
  } });
  assert.equal(changed.code, 'FLEET_ENROLMENT_CHANGED');
  const revokedSession = f.sessionFor(f.owner.user);
  const revoked = await f.setup({ session: revokedSession, body: { ...f.setupBody, expectedRevision: 2 }, directoryReader: async () => {
    f.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(f.config.now().toISOString(), revokedSession.sessionId);
    return { items: [f.tablet.device] };
  } });
  assert.equal(revoked.status, 401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM business_terminal_pairings').get().count, 0);
});

test('signed native-only setup expires, honours loss of owner and exact fleet revision, and keeps the bound proof on the registered terminal', async t => {
  const f = await fixture(t);
  const download = async body => packageProof(await f.setup({ body }), f.tablet);
  const old = await download(f.setupBody);
  const first = await download(f.setupBody);
  assert.notEqual(first.terminalId, old.terminalId);
  assert.equal((await signedTablet(f, old).pair()).status, 401, 'Latest one-use package supersedes earlier issue');
  f.advance(10 * 60_000 + 1);
  assert.equal((await signedTablet(f, first).pair()).status, 401);

  const stale = await download(f.setupBody);
  f.db.prepare('UPDATE admin_tablets SET revision=2 WHERE id=?').run(f.tablet.tabletId);
  assert.equal((await signedTablet(f, stale).pair()).body.error.code, 'FLEET_ENROLMENT_CHANGED');
  const final = await download({ ...f.setupBody, expectedRevision: 2 });
  const tablet = signedTablet(f, final);
  f.demoteOwner();
  assert.equal((await tablet.pair()).body.error.code, 'FLEET_ENROLMENT_ISSUER_REVOKED');
  f.db.prepare("UPDATE business_account_memberships SET permission='owner' WHERE user_id=? AND business_id=?").run(f.owner.user.id, f.business.id);

  const paired = await tablet.pair();
  assert.equal(paired.status, 201, paired.text);
  assert.equal((await tablet.pair()).status, 201, 'Repeated proof with the same key retains one exact registration');
  assert.equal((await signedTablet(f, final).pair()).status, 401, 'A second key cannot reuse a consumed setup');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM business_terminals WHERE business_id=?').get(f.business.id).count, 1);
  assert.equal((await f.setup({ body: { ...f.setupBody, expectedRevision: 3 } })).status, 409);
  assert.equal(JSON.stringify(f.db.prepare('SELECT details FROM audit_events').all()).includes(final.code), false);

  const grant = await tablet.request(`/api/terminal-devices/${final.terminalId}/operator-session`, { method: 'POST', body: {} });
  assert.equal(grant.status, 201, grant.text);
  assert.equal(grant.body.data.restaurantId, null);
  assert.equal(grant.body.data.calaiReadAuthorized, true);
  const { token } = grant.body.data;
  const orders = () => tablet.request('/api/business/calai/orders', { token });
  assert.equal((await orders()).status, 200);
  assert.equal((await tablet.request('/api/restaurant/orders/pending-confirmation', { token })).status, 403);
  const dashboard = await tablet.request('/api/business/dashboard', { token });
  assert.equal(dashboard.status, 200, dashboard.text);
  assert.equal(dashboard.body.data.orders[0].source, 'calai');
  assert.equal(dashboard.body.data.orders[0].totalMinor, null, 'The combined summary respects tablet financial scope');

  f.db.prepare('DELETE FROM tablet_fleet_pairing_requests WHERE terminal_id=?').run(final.terminalId);
  f.db.prepare('DELETE FROM business_terminal_pairings WHERE terminal_id=?').run(final.terminalId);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM tablet_fleet_owner_calai_setups WHERE terminal_id=?').get(final.terminalId).count, 0);
  assert.equal((await orders()).status, 200, 'Registered proof survives consumed setup cleanup');
  const setSourceUser = sourceUser => {
    f.db.prepare("UPDATE business_product_links SET upstream_user_id=? WHERE business_id=? AND product='calai'").run(sourceUser, f.business.id);
    f.db.prepare("UPDATE business_product_authorities SET source_user_id=? WHERE business_id=? AND product='calai'").run(sourceUser, f.business.id);
  };
  setSourceUser(randomUUID());
  assert.equal((await orders()).body.error.code, 'CALAI_AUTHORITY_REQUIRED', 'A new current native proof cannot replace the registered proof');
  setSourceUser(f.state.id);
  // Keep the location operational so the failure specifically tests the revoked registering owner's proof.
  f.db.prepare("INSERT INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source) VALUES(?,?,'owner',?,'master')").run(f.business.id, f.otherOwner.id, f.config.now().toISOString());
  f.demoteOwner();
  assert.equal((await orders()).body.error.code, 'CALAI_AUTHORITY_REQUIRED');
  assert.equal((await f.link({ id: f.business.id, session: f.otherSession })).status, 200);
  const successorCookie = await f.login('restaurant2@calai.local', 'LocalRestaurant2!4310');
  const approvalPath = f.endpoint.replace('calai-first-setup', 'calai-authorization');
  const approve = () => f.json(approvalPath, { method: 'POST', cookie: successorCookie, body: { expectedTerminalId: final.terminalId } });
  const setSerial = serialNumber => f.db.prepare('UPDATE admin_tablets SET serial_number=? WHERE id=?').run(serialNumber, f.tablet.tabletId);
  setSerial('MISMATCHED-SERIAL');
  assert.equal((await approve()).body.error.code, 'CALAI_TABLET_REPLACEMENT_REQUIRED');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM business_terminal_calai_approvals').get().count, 0);
  setSerial(f.tablet.serialNumber);
  const consent = await approve();
  assert.equal(consent.status, 200, consent.text);
  assert.equal(consent.body.data.authorized, true, 'New verified owner can explicitly consent for the same assigned tablet');
  assert.equal((await orders()).status, 200);
  setSerial('MISMATCHED-SERIAL');
  assert.equal((await orders()).body.error.code, 'CALAI_AUTHORITY_REQUIRED', 'Later consent never bypasses the physical assignment binding');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
