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
  return { ...config, owner: approvedOwner, extra: { ...config.extra, eas: { ...config.extra?.eas, projectId: approvedProjectId } } };
};
