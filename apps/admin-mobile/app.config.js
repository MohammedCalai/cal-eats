import fs from "node:fs";
import path from "node:path";

const approvedOwner = "yankee1707";
const approvedProjectId = "6282b87e-36ae-43bb-80b7-12d69108a411";

export default ({ config }) => {
  const owner = process.env.CAL_EATS_EXPO_OWNER?.trim() || config.owner;
  const projectId = process.env.CAL_EATS_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  if (owner?.toLowerCase() !== approvedOwner || projectId !== approvedProjectId) {
    throw new Error("Cal-Eats Admin builds must use their separate approved Yankee1707 project.");
  }
  if (process.env.CAL_EATS_PUBLIC_RELEASE_BUILD === "true" || process.env.EAS_BUILD_PROFILE === "production") {
    throw new Error("Cal-Eats Admin is configured for test distribution only. Public release remains unapproved.");
  }
  const configuredFile = process.env.CAL_EATS_ADMIN_GOOGLE_SERVICES_FILE?.trim();
  let googleServicesFile;
  if (configuredFile) {
    googleServicesFile = path.resolve(configuredFile);
    let value;
    try { value = JSON.parse(fs.readFileSync(googleServicesFile, "utf8")); }
    catch { throw new Error("The private Cal Eats Admin Android notification configuration could not be read."); }
    if (!value?.project_info?.project_id || !value.client?.some(client => client.client_info?.android_client_info?.package_name === "info.calai.caleatsadmin")) throw new Error("Android notification configuration must belong to the separate Cal Eats Admin package.");
  }
  return { ...config, owner: approvedOwner, android: {...config.android,...(googleServicesFile?{googleServicesFile}:{})}, extra: { ...config.extra, businessPush:{androidConfigured:Boolean(googleServicesFile)}, eas: { ...config.extra?.eas, projectId: approvedProjectId } } };
};
