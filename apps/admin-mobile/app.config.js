import fs from 'node:fs';

const managerProjectId = '6282b87e-36ae-43bb-80b7-12d69108a411';
const managerIdentifier = 'info.calai.caleatsadmin';
const firebaseProjectId = 'cal-eats-notifications';
const firebaseProjectNumber = '267285017965';
const firebaseAppId = '1:267285017965:android:806f06e062f0931dbb9664';

/** Keep this app's native registration separate from the customer app. */
export function createAdminAppConfig(config, env = process.env) {
  const requestedOwner = env.CAL_EATS_EXPO_OWNER?.trim() || config.owner;
  const requestedProject = env.CAL_EATS_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  if (config.owner !== 'yankee1707' || config.extra?.eas?.projectId !== managerProjectId ||
      requestedOwner?.toLowerCase() !== 'yankee1707' || requestedProject !== managerProjectId ||
      config.ios?.bundleIdentifier !== managerIdentifier || config.android?.package !== managerIdentifier) {
    throw new Error('Cal-Eats Admin must use its existing approved Expo project and native identifiers.');
  }
  if (env.CAL_EATS_PUBLIC_RELEASE_BUILD === 'true' || env.EAS_BUILD_PROFILE === 'production') {
    throw new Error('Cal-Eats Admin is configured for test distribution only. Public release remains unapproved.');
  }

  // Deliberately do not consume the customer app's GOOGLE_SERVICES_JSON or
  // CAL_EATS_GOOGLE_SERVICES_FILE environment variables.
  const googleServicesFile = env.CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE?.trim() || config.android?.googleServicesFile;
  if (!googleServicesFile) {
    if (env.EAS_BUILD === 'true' && env.EAS_BUILD_PLATFORM === 'android') {
      throw new Error('Android manager builds require CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE for the manager Firebase app.');
    }
    return config;
  }

  let services;
  try {
    services = JSON.parse(fs.readFileSync(googleServicesFile, 'utf8'));
  } catch {
    throw new Error('The manager Firebase configuration file is missing or invalid.');
  }
  const clients = services.client;
  const client = Array.isArray(clients) && clients.length === 1 ? clients[0] : null;
  const projectNumber = services.project_info?.project_number;
  const appId = client?.client_info?.mobilesdk_app_id;
  if (services.project_info?.project_id !== firebaseProjectId ||
      projectNumber !== firebaseProjectNumber ||
      client?.client_info?.android_client_info?.package_name !== managerIdentifier ||
      appId !== firebaseAppId) {
    throw new Error('Use the Firebase Android configuration for info.calai.caleatsadmin in cal-eats-notifications, not the customer app or another sender.');
  }
  return {...config, android: {...config.android, googleServicesFile}};
}

export default ({config}) => createAdminAppConfig(config);
