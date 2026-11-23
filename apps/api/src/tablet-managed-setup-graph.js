import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTabletGraphClient } from './tablet-management-graph.js';

const origin = 'https://graph.microsoft.com';
const scripts = '/beta/deviceManagement/deviceManagementScripts';
const fileName = 'Cal-Eats-Managed-Tablet.ps1';
const description = 'Cal-Eats managed tablet setup. Dedicated script for one managed device.';
const prefix = 'CAL_EATS_MANAGED_SETUP_';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const id = value => typeof value === 'string' && uuid.test(value) && value !== '00000000-0000-0000-0000-000000000000' ? value.toLowerCase() : null;
const serial = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
const fail = (code, retry = false) => Object.assign(new Error(code), { code, retry });
const shape = value => value && typeof value === 'object' && !Array.isArray(value);
const targetFields = ['managedDeviceId', 'groupId', 'directoryObjectId', 'entraDeviceId', 'serialNumber'];

export function loadTabletManagedSetupSettings(input = {}, env = process.env) {
  const enabled = input.enabled ?? (env[prefix + 'ENABLED'] === 'true');
  const tenantId = id(input.tenantId ?? env[prefix + 'TENANT_ID']);
  const clientId = id(input.clientId ?? env[prefix + 'CLIENT_ID']);
  const certificateThumbprint = input.certificateThumbprint ?? env[prefix + 'CERTIFICATE_THUMBPRINT_SHA256'] ?? null;
  const privateKeyFile = input.privateKeyFile ?? env[prefix + 'PRIVATE_KEY_FILE'] ?? null;
  const privateKey = input.privateKey ?? env[prefix + 'PRIVATE_KEY_PEM'] ?? null;
  let targetList = input.targets;
  if (targetList === undefined) {
    try { targetList = JSON.parse(env[prefix + 'TARGETS_JSON'] || '[]'); }
    catch { throw fail('MANAGED_SETUP_GRAPH_SETTINGS_INVALID'); }
  }
  if (targetList instanceof Map) targetList = [...targetList].map(([managedDeviceId, target]) => ({ ...target, managedDeviceId }));
  if (typeof enabled !== 'boolean' || !Array.isArray(targetList) || targetList.length > 10000) throw fail('MANAGED_SETUP_GRAPH_SETTINGS_INVALID');
  const targets = new Map(), groupIds = new Set(), deviceIds = new Set(), entraIds = new Set(), serials = new Set();
  for (const target of targetList) {
    if (!shape(target) || Object.keys(target).length !== targetFields.length || targetFields.some(key => !Object.hasOwn(target, key))) {
      throw fail('MANAGED_SETUP_GRAPH_SETTINGS_INVALID');
    }
    const managedDeviceId = id(target.managedDeviceId), groupId = id(target.groupId), directoryObjectId = id(target.directoryObjectId);
    const entraDeviceId = id(target.entraDeviceId), serialNumber = serial(target.serialNumber);
    if (!managedDeviceId || !groupId || !directoryObjectId || !entraDeviceId || !serialNumber ||
        targets.has(managedDeviceId) || groupIds.has(groupId) || deviceIds.has(directoryObjectId) ||
        entraIds.has(entraDeviceId) || serials.has(serialNumber)) throw fail('MANAGED_SETUP_GRAPH_SETTINGS_INVALID');
    targets.set(managedDeviceId, Object.freeze({ groupId, directoryObjectId, entraDeviceId, serialNumber }));
    groupIds.add(groupId); deviceIds.add(directoryObjectId); entraIds.add(entraDeviceId); serials.add(serialNumber);
  }
  if (enabled && (!tenantId || !clientId || !/^[a-f0-9]{64}$/i.test(certificateThumbprint ?? '') ||
      !(typeof privateKeyFile === 'string' && privateKeyFile.trim() || typeof privateKey === 'string' && privateKey.trim()) || !targets.size)) {
    throw fail('MANAGED_SETUP_GRAPH_SETTINGS_INVALID');
  }
  const readClient = id(env.CAL_EATS_INTUNE_CLIENT_ID), readThumbprint = env.CAL_EATS_INTUNE_CERTIFICATE_THUMBPRINT_SHA256;
  const readFile = env.CAL_EATS_INTUNE_PRIVATE_KEY_FILE;
  if (enabled && (readClient === clientId || readThumbprint?.toLowerCase() === certificateThumbprint.toLowerCase() ||
      readFile && privateKeyFile && path.resolve(readFile).toLowerCase() === path.resolve(privateKeyFile).toLowerCase())) {
    throw fail('MANAGED_SETUP_GRAPH_CREDENTIAL_NOT_SEPARATE');
  }
  return { enabled, tenantId, clientId, certificateThumbprint, privateKeyFile, privateKey, targets };
}

function encodeScript(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) >= 200000 ||
      !/^[\x09\x0a\x0d\x20-\x7e]+$/.test(content)) throw fail('MANAGED_SETUP_GRAPH_SCRIPT_INVALID');
  return Buffer.from(content, 'utf8').toString('base64');
}

function jobEnvelope(settings, input) {
  if (!settings?.enabled) throw fail('MANAGED_SETUP_GRAPH_NOT_CONFIGURED');
  const jobId = id(input?.jobId), managedDeviceId = id(input?.managedDeviceId), target = settings.targets.get(managedDeviceId);
  if (!jobId || !target || target.entraDeviceId !== id(input.entraDeviceId) || target.serialNumber !== serial(input.serialNumber)) {
    throw fail('MANAGED_SETUP_GRAPH_TARGET_MISMATCH');
  }
  return { jobId, managedDeviceId, target, displayName: `Cal-Eats managed tablet ${jobId}`,
    scriptContent: encodeScript(input.scriptContent) };
}

async function bounded(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = fail('MANAGED_SETUP_GRAPH_DEADLINE', true);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([work(controller.signal), timeout]);
  } finally { clearTimeout(timer); controller.abort(); }
}

async function readJson(response, signal) {
  const maxBytes = 2 * 1024 * 1024;
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') ?? '') ||
      Number(response.headers?.get('content-length')) > maxBytes || !response.body?.getReader) {
    throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID');
  }
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { cancel(); throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID'); }
      chunks.push(Buffer.from(value));
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID'); }
    if (!shape(parsed)) throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID');
    return parsed;
  } catch (error) {
    if (error.code?.startsWith('MANAGED_SETUP_GRAPH_')) throw error;
    throw fail('MANAGED_SETUP_GRAPH_NETWORK', true);
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

function continuation(raw, initial) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\x00-\x1f\x7f]/.test(raw)) throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID');
  let url;
  try { url = new URL(raw); } catch { throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID'); }
  const entries = [...url.searchParams];
  if (url.origin !== origin || url.pathname !== initial.pathname || url.username || url.password || url.hash ||
      new Set(entries.map(([key]) => key)).size !== entries.length ||
      [...initial.searchParams].some(([key, value]) => url.searchParams.get(key) !== value) ||
      entries.some(([key, value]) => /[\x00-\x1f\x7f]/.test(value) ||
        !initial.searchParams.has(key) && (key !== '$skiptoken' || !value || value.length > 4096) && (key !== '$skip' || !/^\d{1,8}$/.test(value)))) {
    throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID');
  }
  if (!url.searchParams.has('$skiptoken') && !url.searchParams.has('$skip')) throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID');
  return url;
}

export function createTabletManagedSetupGraph(settings, {
  fetchImpl = fetch, clientFactory = createTabletGraphClient, now = Date.now, timeoutMs = 75000, requestTimeoutMs = 10000
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000 || !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 || requestTimeoutMs > 15000) throw new TypeError('Managed setup deadlines are invalid');
  let client;
  async function tokenFor(signal) {
    try {
      client ??= Promise.resolve().then(() => clientFactory(settings));
      const auth = await (await client).acquireTokenByClientCredential({ scopes: [`${origin}/.default`] });
      signal.throwIfAborted();
      // App-only MSAL results may have no tenantId because there is no ID token.
      const authority = new URL(auth?.authority ?? '');
      if (authority.origin !== 'https://login.microsoftonline.com' || authority.pathname.replace(/\/$/, '').toLowerCase() !== `/${settings.tenantId}` ||
          authority.username || authority.password || authority.search || authority.hash ||
          auth.tenantId && id(auth.tenantId) !== settings.tenantId || typeof auth.accessToken !== 'string' || !auth.accessToken) {
        throw fail('MANAGED_SETUP_GRAPH_IDENTITY_REQUIRED');
      }
      return auth.accessToken;
    } catch (error) {
      client = undefined;
      if (error.code?.startsWith('MANAGED_SETUP_GRAPH_')) throw error;
      const transient = /network|timeout|temporarily_unavailable|server_error/i.test(error.errorCode ?? '');
      throw fail(transient ? 'MANAGED_SETUP_GRAPH_NETWORK' : 'MANAGED_SETUP_GRAPH_IDENTITY_REQUIRED', transient);
    }
  }

  async function request(method, url, token, signal, { body, expected = 200, notFoundRetry = false } = {}) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
    let response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(url.href, { method, signal: requestSignal, redirect: 'error', headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/json', 'client-request-id': randomUUID(),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      requestSignal.throwIfAborted();
    } catch { throw fail('MANAGED_SETUP_GRAPH_NETWORK', true); }
    if (response.status === 401 || response.status === 403) throw fail('MANAGED_SETUP_GRAPH_PERMISSION_REQUIRED');
    if (response.status === 404) throw fail('MANAGED_SETUP_GRAPH_NOT_FOUND', notFoundRetry);
    if (response.status === 429 || response.status >= 500) throw fail('MANAGED_SETUP_GRAPH_PROVIDER_RETRY', true);
    if (response.status !== expected) throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID');
    return expected === 204 ? null : readJson(response, requestSignal);
  }

  const key = (route, query) => { const url = new URL(origin + route); if (query) url.search = new URLSearchParams(query); return url; };
  const get = (token, signal, route, query, options) => request('GET', key(route, query), token, signal, options);
  function exactItems(response, limit) {
    if (!Array.isArray(response.value) || response.value.length > limit || Object.hasOwn(response, '@odata.nextLink') && response['@odata.nextLink'] !== null) {
      throw fail('MANAGED_SETUP_GRAPH_SCOPE_AMBIGUOUS');
    }
    return response.value;
  }

  async function verifyTarget(job, token, signal) {
    const { managedDeviceId, target } = job;
    const [managed, directory, group, members] = await Promise.all([
      get(token, signal, `/v1.0/deviceManagement/managedDevices/${managedDeviceId}`, { '$select': 'id,azureADDeviceId,serialNumber,operatingSystem,managementState' }),
      get(token, signal, `/v1.0/devices/${target.directoryObjectId}`, { '$select': 'id,deviceId,accountEnabled,trustType' }),
      get(token, signal, `/v1.0/groups/${target.groupId}`, { '$select': 'id,securityEnabled,mailEnabled,groupTypes,membershipRule,isAssignableToRole' }),
      // The documented v1.0 membership response can omit service principals.
      get(token, signal, `/beta/groups/${target.groupId}/members`, { '$top': '2' })
    ]);
    if (id(managed.id) !== managedDeviceId || id(managed.azureADDeviceId) !== target.entraDeviceId ||
        serial(managed.serialNumber) !== target.serialNumber || managed.operatingSystem !== 'Windows' || managed.managementState !== 'managed' ||
        id(directory.id) !== target.directoryObjectId || id(directory.deviceId) !== target.entraDeviceId || directory.accountEnabled !== true ||
        !['azuread', 'serverad'].includes(String(directory.trustType).toLowerCase())) throw fail('MANAGED_SETUP_GRAPH_TARGET_MISMATCH');
    const direct = exactItems(members, 1);
    if (id(group.id) !== target.groupId || group.securityEnabled !== true || group.mailEnabled !== false ||
        !Array.isArray(group.groupTypes) || group.groupTypes.length !== 0 || group.membershipRule != null || ![false, null].includes(group.isAssignableToRole) ||
        direct.length !== 1 || direct[0]?.['@odata.type'] !== '#microsoft.graph.device' || id(direct[0]?.id) !== target.directoryObjectId) {
      throw fail('MANAGED_SETUP_GRAPH_GROUP_UNSAFE');
    }
  }

  async function findScript(job, token, signal) {
    const initial = key(scripts, { '$select': 'id,displayName', '$top': '100' });
    let url = initial, found = null;
    const visited = new Set();
    for (let page = 0; page < 10; page++) {
      if (visited.has(url.href)) throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID');
      visited.add(url.href);
      const result = await request('GET', url, token, signal);
      if (!Array.isArray(result.value) || result.value.length > 100) throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID');
      for (const item of result.value) {
        if (item?.displayName !== job.displayName) continue;
        if (found || !id(item.id)) throw fail('MANAGED_SETUP_GRAPH_SCRIPT_AMBIGUOUS');
        found = id(item.id);
      }
      if (result['@odata.nextLink'] == null) return found;
      url = continuation(result['@odata.nextLink'], initial);
    }
    throw fail('MANAGED_SETUP_GRAPH_PAGING_INVALID');
  }

  async function verifyScript(job, scriptId, token, signal, previous = null) {
    const script = await get(token, signal, `${scripts}/${scriptId}`, {
      '$select': 'id,displayName,description,fileName,scriptContent,runAsAccount,runAs32Bit,enforceSignatureCheck,lastModifiedDateTime'
    }, { notFoundRetry: true });
    if (id(script.id) !== scriptId || script.displayName !== job.displayName || script.description !== description ||
        script.fileName !== fileName || (script.scriptContent !== job.scriptContent && (!previous || script.scriptContent !== previous)) ||
        script.runAsAccount !== 'system' ||
        script.runAs32Bit !== false || script.enforceSignatureCheck !== false) throw fail('MANAGED_SETUP_GRAPH_SCRIPT_MISMATCH');
    return script;
  }

  async function assignmentPresent(job, scriptId, token, signal) {
    const [modern, legacy] = await Promise.all([
      get(token, signal, `${scripts}/${scriptId}/assignments`, null, { notFoundRetry: true }),
      get(token, signal, `${scripts}/${scriptId}/groupAssignments`, null, { notFoundRetry: true })
    ]);
    const rows = exactItems(modern, 1), old = exactItems(legacy, 1), target = rows[0]?.target;
    if (rows.length && (target?.['@odata.type'] !== '#microsoft.graph.groupAssignmentTarget' || id(target.groupId) !== job.target.groupId ||
        ![null, undefined, 'none'].includes(target.deviceAndAppManagementAssignmentFilterType) || target.deviceAndAppManagementAssignmentFilterId) ||
        old.length && id(old[0]?.targetGroupId) !== job.target.groupId) throw fail('MANAGED_SETUP_GRAPH_ASSIGNMENT_UNSAFE');
    return rows.length === 1 || old.length === 1;
  }

  async function permit(callback, code, signal) {
    try { if (typeof callback !== 'function' || !await callback()) throw fail(code); }
    catch { throw fail(code); }
    signal.throwIfAborted();
  }

  async function dispatch(input) {
    const job = jobEnvelope(settings, input);
    if (input.allowCreate !== undefined && typeof input.allowCreate !== 'boolean') throw fail('MANAGED_SETUP_GRAPH_SCRIPT_INVALID');
    let scriptId = null, createStarted = false;
    try {
      return await bounded(async signal => {
        const token = await tokenFor(signal);
        await verifyTarget(job, token, signal);
        scriptId = await findScript(job, token, signal);
        if (!scriptId) {
          if (input.allowCreate !== true) throw fail('MANAGED_SETUP_GRAPH_CREATE_UNCONFIRMED', true);
          await permit(input.beginCreate, 'MANAGED_SETUP_GRAPH_CREATE_BLOCKED', signal);
          createStarted = true;
          const script = await request('POST', key(scripts), token, signal, { expected: 201, body: {
            '@odata.type': '#microsoft.graph.deviceManagementScript', displayName: job.displayName, description, fileName,
            scriptContent: job.scriptContent, runAsAccount: 'system', runAs32Bit: false, enforceSignatureCheck: false
          } });
          scriptId = id(script.id);
          if (!scriptId) throw fail('MANAGED_SETUP_GRAPH_RESPONSE_INVALID');
        }
        await verifyScript(job, scriptId, token, signal);
        if (!await assignmentPresent(job, scriptId, token, signal)) {
          await verifyTarget(job, token, signal);
          if (input.beforeAssign !== undefined) await permit(input.beforeAssign, 'MANAGED_SETUP_GRAPH_ASSIGNMENT_BLOCKED', signal);
          await request('POST', key(`${scripts}/${scriptId}/assign`), token, signal, { expected: 204, body: {
            deviceManagementScriptGroupAssignments: [],
            deviceManagementScriptAssignments: [{ '@odata.type': '#microsoft.graph.deviceManagementScriptAssignment',
              target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: job.target.groupId } }]
          } });
          if (!await assignmentPresent(job, scriptId, token, signal)) throw fail('MANAGED_SETUP_GRAPH_ASSIGNMENT_UNCONFIRMED', true);
        }
        return { scriptId };
      }, timeoutMs);
    } catch (error) {
      if (scriptId) error.scriptId = scriptId;
      if (createStarted && !scriptId && error.code !== 'MANAGED_SETUP_GRAPH_PERMISSION_REQUIRED') {
        error.ambiguousCreate = true;
        error.retry = true;
      }
      throw error;
    }
  }

  async function redeliver(input) {
    const job = jobEnvelope(settings, input), scriptId = id(input.scriptId);
    const previous = encodeScript(input.previousScriptContent);
    if (!scriptId || previous === job.scriptContent || input.allowUpdate !== undefined && typeof input.allowUpdate !== 'boolean') {
      throw fail('MANAGED_SETUP_GRAPH_SCRIPT_INVALID');
    }
    let updateStarted = false, providerConfirmed = false;
    try {
      return await bounded(async signal => {
        const token = await tokenFor(signal);
        await verifyTarget(job, token, signal);
        const found = await findScript(job, token, signal);
        if (!found) throw fail('MANAGED_SETUP_GRAPH_NOT_FOUND', true);
        if (found !== scriptId) throw fail('MANAGED_SETUP_GRAPH_SCRIPT_MISMATCH');
        const current = await verifyScript(job, scriptId, token, signal, previous);
        if (!await assignmentPresent(job, scriptId, token, signal)) throw fail('MANAGED_SETUP_GRAPH_ASSIGNMENT_UNCONFIRMED', true);
        if (current.scriptContent === job.scriptContent) return { scriptId };
        if (input.allowUpdate !== true) throw fail('MANAGED_SETUP_GRAPH_UPDATE_UNCONFIRMED', true);
        await verifyTarget(job, token, signal);
        await permit(input.beginUpdate, 'MANAGED_SETUP_GRAPH_UPDATE_BLOCKED', signal);
        updateStarted = true;
        await request('PATCH', key(`${scripts}/${scriptId}`), token, signal, { body: { scriptContent: job.scriptContent } });
        const updated = await verifyScript(job, scriptId, token, signal, previous);
        if (updated.scriptContent !== job.scriptContent) throw fail('MANAGED_SETUP_GRAPH_UPDATE_UNCONFIRMED', true);
        providerConfirmed = true;
        await verifyTarget(job, token, signal);
        if (!await assignmentPresent(job, scriptId, token, signal)) throw fail('MANAGED_SETUP_GRAPH_ASSIGNMENT_UNCONFIRMED', true);
        return { scriptId };
      }, timeoutMs);
    } catch (error) {
      if (updateStarted && !providerConfirmed && error.code !== 'MANAGED_SETUP_GRAPH_PERMISSION_REQUIRED' &&
          error.code !== 'MANAGED_SETUP_GRAPH_SCRIPT_MISMATCH') {
        error.ambiguousUpdate = true;
        error.retry = true;
      }
      throw error;
    }
  }

  async function observe(input) {
    const job = jobEnvelope(settings, input), scriptId = id(input.scriptId);
    const { deliveryRevision = 1 } = input;
    const requestedAt = typeof input.requestedAt === 'string' ? Date.parse(input.requestedAt) : NaN;
    if (!scriptId || !Number.isSafeInteger(deliveryRevision) || deliveryRevision < 1 ||
        !Number.isFinite(requestedAt) || requestedAt > now()) throw fail('MANAGED_SETUP_GRAPH_EVIDENCE_INVALID');
    return bounded(async signal => {
      const token = await tokenFor(signal);
      await verifyTarget(job, token, signal);
      const script = await verifyScript(job, scriptId, token, signal);
      if (!await assignmentPresent(job, scriptId, token, signal)) return null;
      const response = await get(token, signal, `${scripts}/${scriptId}/deviceRunStates`, { '$expand': 'managedDevice($select=id)', '$top': '2' });
      const runs = exactItems(response, 1), run = runs[0];
      if (!run) return null;
      if (id(run.managedDevice?.id) !== job.managedDeviceId || typeof run.id !== 'string' || !run.id ||
          run.id.length > 200 || /[\x00-\x1f\x7f]/.test(run.id)) throw fail('MANAGED_SETUP_GRAPH_RUN_SCOPE_MISMATCH');
      const observed = typeof run.lastStateUpdateDateTime === 'string' ? Date.parse(run.lastStateUpdateDateTime) : NaN;
      const modified = typeof script.lastModifiedDateTime === 'string' ? Date.parse(script.lastModifiedDateTime) : NaN;
      const since = Math.max(requestedAt, modified);
      const fresh = (deliveryRevision === 1 ? observed >= since : observed > since) && observed <= now() + 60000;
      if (['fail', 'scriptError', 'notApplicable'].includes(run.runState) && fresh) {
        throw fail('MANAGED_SETUP_GRAPH_EXECUTION_FAILED');
      }
      if (run.runState !== 'success') return null;
      if (!Number.isFinite(observed) || !Number.isFinite(modified) || observed > now() + 60000 || modified > now() + 60000 ||
          typeof run.resultMessage !== 'string' || Buffer.byteLength(run.resultMessage) > 8192 || !run.resultMessage.trim()) {
        throw fail('MANAGED_SETUP_GRAPH_EVIDENCE_INVALID');
      }
      if (!fresh) return null;
      return { resultMessage: run.resultMessage, observedAt: new Date(observed).toISOString() };
    }, timeoutMs);
  }

  return { dispatch, redeliver, observe };
}
