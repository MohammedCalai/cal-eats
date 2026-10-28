import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];
const required = [
  "package.json", "package-lock.json", ".gitignore", ".gitattributes",
  ".editorconfig", ".env.example", ".nvmrc", "README.md",
  "apps/api/src/main.js", "apps/api/scripts/bootstrap-admin.js", "apps/web/index.html",
  "apps/web/manifest.webmanifest", "apps/web/sw.js", "apps/web/offline.html",
  "packages/contracts/src/index.js", "Dockerfile", ".dockerignore", "infra/healthcheck.js",
  "docs/HOSTED_PREVIEW.md", "docs/CONTAINER_PREVIEW.md", "docs/PHONE_INSTALL.md",
  "apps/admin-mobile/App.tsx", "apps/admin-mobile/app.json", "docs/MIGRATION_HANDOFF.md"
];

for (const file of required) if (!existsSync(join(root, file))) failures.push(`Missing required file: ${file}`);

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lock = existsSync(join(root, "package-lock.json")) ? JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) : null;
if (lock && (lock.name !== packageJson.name || lock.lockfileVersion !== 3)) failures.push("package-lock.json does not match the root package or npm lockfile format.");
if (lock && JSON.stringify(lock.packages?.[""]?.workspaces) !== JSON.stringify(packageJson.workspaces)) failures.push("package-lock.json workspace metadata is out of date.");
if (lock && JSON.stringify(lock.packages?.[""]?.engines) !== JSON.stringify(packageJson.engines)) failures.push("package-lock.json runtime metadata is out of date.");
if (lock) {
  for (const workspace of ["apps/api", "apps/web", "apps/portal", "apps/mobile", "apps/admin-mobile", "apps/print-bridge", "packages/contracts"]) {
    const manifest = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"));
    const locked = lock.packages?.[workspace];
    if (!locked || locked.name !== manifest.name || locked.version !== manifest.version || JSON.stringify(locked.dependencies || {}) !== JSON.stringify(manifest.dependencies || {})) failures.push(`package-lock.json is out of date for ${workspace}.`);
  }
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const sourceRoots = ["apps/api/src", "apps/api/scripts", "apps/web", "apps/print-bridge/src", "packages/contracts/src", "scripts", "infra"];
const javascript = sourceRoots.flatMap((dir) => filesUnder(join(root, dir))).filter((file) => extname(file) === ".js");
for (const file of javascript) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`Syntax check failed: ${relative(root, file)}\n${result.stderr.trim()}`);
}

try {
  const remoteConfig = spawnSync("git", ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"], { cwd: root, encoding: "utf8" });
  if (remoteConfig.status > 1) failures.push("Could not inspect Git remote destinations.");
  if (/github\.com[/:]calai-operation\//i.test(remoteConfig.stdout || "")) failures.push("Original Calai GitHub account must not be configured as a Cal-Eats remote destination.");
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  const privatePattern = /(^|\/)(?:data|backups|logs|artifacts|local-mail|mail|reference|node_modules|\.expo)(\/|$)|apps\/print-bridge\/(?:config\.json|var\/)|(^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-shm|-wal)?|log|zip|tar|tgz)$/i;
  const disallowed = tracked.filter((file) => file !== ".env.example" && privatePattern.test(file.replaceAll(sep, "/")));
  if (disallowed.length) failures.push(`Remove private/local artifacts from the tracked upload set:\n${disallowed.map((file) => `  - ${file}`).join("\n")}`);
} catch (error) {
  failures.push(`Could not inspect the Git upload set: ${error.message}`);
}

console.log("LOCAL PREVIEW / PRODUCTION NOT ENABLED");
console.log(`Checked ${javascript.length} JavaScript source files and ${required.length} required release files.`);
if (failures.length) {
  console.error(`Release check found ${failures.length} issue(s):\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Release packaging checks passed.");
}
