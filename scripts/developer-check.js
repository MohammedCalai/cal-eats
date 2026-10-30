import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const npmCli = process.env.npm_execpath;
if (process.versions.node !== manifest.engines.node || !npmCli || !existsSync(npmCli)) {
  console.error(`Use Node ${manifest.engines.node} and run npm run check:developer.`);
  process.exit(1);
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(CALAI_|STRIPE_|AZURE_|VITE_|EXPO_PUBLIC_)/i.test(key) || ["NODE_OPTIONS", "NODE_ENV"].includes(key)) delete env[key];
}
Object.assign(env, { CALAI_RUN_MODE: "local", CALAI_PAYMENT_PROVIDER: "local_simulator", CALAI_LIVE_PAYMENTS_ENABLED: "false", CALAI_ORDER_ALERT_EMAIL_MODE: "local", CALAI_MAIL_GRAPH_ENABLED: "false", CALAI_BUSINESS_STATEMENTS_SEND_ENABLED: "false" });
const npmVersion = spawnSync(process.execPath, [npmCli, "--version"], { cwd: root, env, encoding: "utf8" });
if (npmVersion.status !== 0 || npmVersion.stdout.trim() !== manifest.engines.npm) {
  console.error(`Developer checks require npm ${manifest.engines.npm}.`);
  process.exit(1);
}

// No server startup, seeding, existing-data migrations, external-provider
// checks, deployments or device operations belong in this validation command.
// Build first so routing tests exercise the generated portal on a fresh clone.
for (const task of ["portal:build", "check", "mobile:check", "admin:mobile:check", "release:check"]) {
  const start = performance.now();
  console.log(`Developer check: ${task}`);
  const result = spawnSync(process.execPath, [npmCli, "run", task], { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`Developer check failed: ${task}`);
    process.exit(result.status || 1);
  }
  console.log(`${task} passed in ${Math.round((performance.now() - start) / 1000)}s`);
}
console.log("Developer checks passed. This does not certify production capacity, external providers or physical printers.");
