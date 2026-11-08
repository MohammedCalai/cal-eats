// Public release is fail-closed: missing gates cannot disappear from the check.
export const REQUIRED_PUBLIC_RELEASE_GATES = Object.freeze([
  'publicReleaseApproved',
  'backendUpdateDeployedAndReviewed',
  'livePaymentsAndRestaurantPayoutsVerified',
  'accountRecoveryEmailVerified',
  'privacyAndTermsApproved',
  'accountDeletionCompletedAndVerified',
  'backgroundNotificationsVerified',
  'iosLiveActivityBackgroundAndTerminalVerified',
  'iosPhysicalDeviceVerified',
  'androidPhysicalDeviceVerified',
  'weakTestPasswordsReplaced',
  'storeListingsAndReviewAccessApproved'
]);

export function validateReleaseReadiness(value) {
  const errors = [], object = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object) errors.push('Readiness must be an object containing every required boolean gate.');
  for (const key of REQUIRED_PUBLIC_RELEASE_GATES) {
    if (!object || !Object.hasOwn(value, key)) errors.push(`Missing readiness gate: ${key}`);
    else if (typeof value[key] !== 'boolean') errors.push(`Readiness gate must be boolean: ${key}`);
  }
  if (object) for (const key of Object.keys(value)) if (!REQUIRED_PUBLIC_RELEASE_GATES.includes(key)) errors.push(`Unknown readiness gate: ${key}`);
  const pending = REQUIRED_PUBLIC_RELEASE_GATES.filter(key => !object || !Object.hasOwn(value, key) || value[key] !== true);
  return { valid: errors.length === 0, approved: errors.length === 0 && pending.length === 0, pending, errors };
}
