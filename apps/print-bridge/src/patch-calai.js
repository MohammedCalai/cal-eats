import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const marker = "// Cal-Eats shared Calai bridge v1";
const nativeFile = name => readFileSync(new URL(`../calai-native/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const supported = new Set(JSON.parse(nativeFile("supported-hashes.json")));

export function patchCalaiBridge(source) {
  if (source.startsWith(marker + "\n")) return source;
  if (!supported.has(crypto.createHash("sha256").update(source).digest("hex"))) {
    throw new Error("This Calai bridge version has not been reviewed; its source was left unchanged");
  }
  const original = "function sendToNetworkPrinter(ip, port, textContent) {";
  if (source.split(original).length !== 2) throw new Error("Calai printer routine is not recognized");
  const dispatch = nativeFile("shared-prefix.txt");
  const connection = nativeFile("shared-suffix.txt");
  return dispatch + source.replace(original, "function calaiOriginalNetworkPrinter(ip, port, textContent) {") + connection;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output || input === output) throw new Error("Provide separate source and staged output paths");
    await fs.writeFile(output, patchCalaiBridge(await fs.readFile(input, "utf8")), { flag: "wx" });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
