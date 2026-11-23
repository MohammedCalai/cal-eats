import {HttpError} from './http.js';
import {createTabletManagementGraphAdapter} from './tablet-management-graph.js';

const readers = new WeakMap();
const errorMessages = {
  GRAPH_NOT_CONFIGURED: 'The existing read-only Microsoft connection is not configured.',
  GRAPH_PERMISSION_REQUIRED: 'The Microsoft connection cannot read the tablet directory. Its administrator must check the existing device-read permission.',
  GRAPH_IDENTITY_REQUIRED: 'The Microsoft connection needs its existing certificate checked.'
};

export async function readTabletDirectory(config) {
  if (!config.tabletManagement?.enabled) throw new HttpError(503, 'TABLET_DIRECTORY_UNAVAILABLE', errorMessages.GRAPH_NOT_CONFIGURED);
  let state = readers.get(config);
  if (!state) { state = {adapter: createTabletManagementGraphAdapter(config.tabletManagement, {now: () => config.now().getTime()})}; readers.set(config, state); }
  if (state.value && config.now().getTime() - state.receivedAt < 30_000) return state.value;
  if (!state.pending) state.pending = state.adapter.listWindowsDevices().then(value => {
    state.value = value; state.receivedAt = config.now().getTime(); return value;
  }).catch(error => {
    // Do not fall back to old observations as a current directory or leak Graph replies.
    throw new HttpError(503, 'TABLET_DIRECTORY_UNAVAILABLE', errorMessages[error.code] || 'The tablet directory could not be read. Try again shortly; saved assignments remain available.');
  }).finally(() => { state.pending = null; });
  return state.pending;
}
