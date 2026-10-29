// A pending queue owns the alarm; closing its popup or changing a preference
// must not acknowledge a restaurant order. Device/browser audio must be unlocked.
export function pendingOrderSoundRequired({ signedIn, pendingCount, unlocked, active = true, verified = true }) {
  return Boolean(signedIn && unlocked && active && verified && Number.isInteger(pendingCount) && pendingCount > 0);
}
export function canMuteOrderSound(pendingCount) { return pendingCount === 0; }
