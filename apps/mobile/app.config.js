export default ({ config }) => {
  const projectId = process.env.CAL_EATS_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  const owner = process.env.CAL_EATS_EXPO_OWNER?.trim() || config.owner;
  const googleServicesFile = process.env.CAL_EATS_GOOGLE_SERVICES_FILE?.trim() || process.env.GOOGLE_SERVICES_JSON?.trim();
  const primaryProject = projectId === "5bf59184-c670-44f4-be78-5229cbd02300" && owner?.toLowerCase() === "yankee1707";
  const alternateAndroidProject = projectId === "f76a2adf-34ca-438a-9208-bdb5d4e65ded" && owner?.toLowerCase() === "bondu17" && (process.env.EAS_BUILD_PLATFORM || process.env.CAL_EATS_BUILD_PLATFORM) === "android";
  if (!primaryProject && !alternateAndroidProject) throw new Error("Cal-Eats builds must use an approved project; the alternate account is Android only.");
  if (projectId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId)) throw new Error("CAL_EATS_EAS_PROJECT_ID must identify the independent Cal-Eats Expo project.");
  if (owner && !/^[a-z0-9._-]+$/i.test(owner)) throw new Error("CAL_EATS_EXPO_OWNER is invalid.");
  return {
    ...config,
    ...(googleServicesFile ? { android: { ...config.android, googleServicesFile } } : {}),
    ...(owner ? { owner } : {}),
    ...(projectId ? { extra: { ...config.extra, eas: { projectId } } } : {})
  };
};
