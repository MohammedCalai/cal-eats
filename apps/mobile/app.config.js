export default ({ config }) => {
  const projectId = process.env.CAL_EATS_EAS_PROJECT_ID?.trim() || config.extra?.eas?.projectId;
  const owner = process.env.CAL_EATS_EXPO_OWNER?.trim() || config.owner;
  if (projectId !== "5bf59184-c670-44f4-be78-5229cbd02300" || owner?.toLowerCase() !== "yankee1707") throw new Error("Cal-Eats builds must use the approved Yankee1707 project.");
  if (projectId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId)) throw new Error("CAL_EATS_EAS_PROJECT_ID must identify the independent Cal-Eats Expo project.");
  if (owner && !/^[a-z0-9._-]+$/i.test(owner)) throw new Error("CAL_EATS_EXPO_OWNER is invalid.");
  return {
    ...config,
    ...(owner ? { owner } : {}),
    ...(projectId ? { extra: { ...config.extra, eas: { projectId } } } : {})
  };
};
