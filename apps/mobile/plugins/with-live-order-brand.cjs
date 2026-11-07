const fs = require("node:fs");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");

// Keep the existing Calai symbol inside the widget's signed asset catalogue.
// No image path, remote image or customer data is sent through ActivityKit.
module.exports = config => withXcodeProject(config, mod => {
  const project = mod.modResults, name = "ExpoWidgetsTarget";
  const targets = project.pbxNativeTargetSection();
  const target = Object.entries(targets).find(([key, value]) => !key.endsWith("_comment") && String(value.name).replaceAll('"', "") === name);
  const group = project.findPBXGroupKey({ name });
  if (!target || !group) throw new Error("Cal-Eats Live Order branding requires the expo-widgets extension first.");
  const catalogue = path.join(mod.modRequest.platformProjectRoot, name, "CalEatsLiveAssets.xcassets");
  const image = path.join(catalogue, "CalEatsLiveSymbol.imageset");
  fs.mkdirSync(image, { recursive: true });
  fs.writeFileSync(path.join(catalogue, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }));
  fs.copyFileSync(path.join(mod.modRequest.projectRoot, "assets/calai-symbol.png"), path.join(image, "symbol.png"));
  fs.writeFileSync(path.join(image, "Contents.json"), JSON.stringify({ images: [{ filename: "symbol.png", idiom: "universal" }], info: { author: "xcode", version: 1 } }));
  // xcode's resource lookup falls back to the main app if an extension has no
  // resource phase. Create the extension's own phase before adding its image.
  const resources = project.hash.project.objects.PBXResourcesBuildPhase || {};
  if (!target[1].buildPhases.some(phase => resources[phase.value])) project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target[0]);
  if (!project.hasFile("CalEatsLiveAssets.xcassets")) project.addResourceFile("CalEatsLiveAssets.xcassets", { target: target[0] }, group);
  return mod;
});
