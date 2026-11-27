const callFields = ["activeCalls", "agentsInUse", "ringing", "queued", "forwarding"];
const orderFields = ["liveOrders", "pendingConfirmation", "confirmedInKitchen", "readyForHandover"];

function counts(source, fields) {
  if (!source || !fields.every(field => Number.isSafeInteger(source[field]) && source[field] >= 0)) return null;
  return Object.fromEntries(fields.map(field => [field, source[field]]));
}

export function embeddedLiveStats(dashboard) {
  return {
    calaiLiveCalls: counts(dashboard?.calaiLiveCalls, callFields),
    eatsLiveOrders: counts(dashboard?.eatsLiveOrders, orderFields),
  };
}
