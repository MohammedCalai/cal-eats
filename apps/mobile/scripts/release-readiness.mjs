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

const platformOnlyGates = Object.freeze({
  android: Object.freeze(['androidPhysicalDeviceVerified']),
  ios: Object.freeze(['iosLiveActivityBackgroundAndTerminalVerified', 'iosPhysicalDeviceVerified'])
});
const commonGates = REQUIRED_PUBLIC_RELEASE_GATES.filter(key => !Object.values(platformOnlyGates).flat().includes(key));

export function validateReleaseReadiness(value, { platform } = {}) {
  const errors = [], object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const knownPlatform = platform === undefined || Object.hasOwn(platformOnlyGates, platform);
  if (!knownPlatform) errors.push('Release platform must be android or ios.');
  // A platform-specific build requires its own device evidence. It cannot
  // substitute an iPhone check for Android evidence, or vice versa.
  const required = platform === undefined || !knownPlatform ? REQUIRED_PUBLIC_RELEASE_GATES : [...commonGates, ...platformOnlyGates[platform]];
  if (!object) errors.push('Readiness must be an object containing every required boolean gate.');
  for (const key of required) {
    if (!object || !Object.hasOwn(value, key)) errors.push(`Missing readiness gate: ${key}`);
    else if (typeof value[key] !== 'boolean') errors.push(`Readiness gate must be boolean: ${key}`);
  }
  if (object) for (const key of Object.keys(value)) {
    if (!REQUIRED_PUBLIC_RELEASE_GATES.includes(key)) errors.push(`Unknown readiness gate: ${key}`);
    else if (!required.includes(key) && typeof value[key] !== 'boolean') errors.push(`Readiness gate must be boolean: ${key}`);
  }
  const pending = required.filter(key => !object || !Object.hasOwn(value, key) || value[key] !== true);
  return { valid: errors.length === 0, approved: errors.length === 0 && pending.length === 0, pending, errors };
}
