import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { expo } = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const eas = JSON.parse(fs.readFileSync(path.join(root, "eas.json"), "utf8"));
const readiness = JSON.parse(fs.readFileSync(path.join(root, "release-readiness.json"), "utf8"));
const checks = [];
const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
check("Both customer-app platforms are configured", ["ios", "android"].every(platform => expo.platforms.includes(platform)));
check("Independent customer application identifiers", expo.ios.bundleIdentifier === "uk.co.calai.caleats" && expo.android.package === "uk.co.calai.caleats");
check("Version and build numbers", /^\d+\.\d+\.\d+$/.test(expo.version) && Number(expo.ios.buildNumber) > 0 && expo.android.versionCode > 0);
const icon = fs.readFileSync(path.resolve(root, expo.icon));
check("Square store icon of at least 1024 pixels", icon.subarray(1, 4).toString() === "PNG" && icon.readUInt32BE(16) === icon.readUInt32BE(20) && icon.readUInt32BE(16) >= 1024);
check("Internal Android APK and store AAB profiles", eas.build.preview.android.buildType === "apk" && eas.build.production.android.buildType === "app-bundle");
const android = expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === "expo-build-properties")?.[1]?.android;
check("Android target meets the checked API 36 minimum", android?.targetSdkVersion >= 36 && android?.compileSdkVersion >= 36);
check("Preview has an independent HTTPS API", eas.build.preview.env.EXPO_PUBLIC_API_BASE_URL === "https://eats.calai.info");
const pending = Object.entries(readiness).filter(([, value]) => value !== true).map(([name]) => name);
const production = process.env.EAS_BUILD_PROFILE === "production" || process.env.CAL_EATS_PUBLIC_RELEASE_BUILD === "true" || process.argv.includes("--production");
if (production) {
  check("Approved Cal-Eats Expo project and owner", expo.extra?.eas?.projectId === "5bf59184-c670-44f4-be78-5229cbd02300" && expo.owner === "yankee1707");
  check("All public-release evidence reviewed", pending.length === 0);
}
console.log(JSON.stringify({ scope: production ? "public-store-release" : "local-build-configuration", checks, publicReleaseReady: pending.length === 0 && checks.every(row => row.passed), pendingEvidence: pending, limitations: ["Configuration checks are not signed builds, device tests, provider verification or store approval.", "Both publishing accounts exist according to the owner; they have not been linked to this independent app here."] }, null, 2));
if (checks.some(row => !row.passed)) process.exitCode = 1;
