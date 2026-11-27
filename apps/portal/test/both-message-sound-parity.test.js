import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Calai review overlay builds independently. Its copies of the player and
// reminder must match Cal-Eats so either checkout produces the same sound.
test("the Both overlay uses the standalone message melody and repeat controller verbatim", async () => {
  const patchUrl = new URL("../../../integration/calai-business-frontend/both-preview/calai-both-workspace.patch", import.meta.url);
  const patch = (await readFile(patchUrl, "utf8")).replaceAll("\r\n", "\n");
  for (const name of ["business-message-audio.js", "business-message-melody-player.js"]) {
    const target = `frontend/src/components/cal-eats/${name}`;
    const file = patch.split(`diff --git a/${target} b/${target}\n`)[1]?.split("\ndiff --git ")[0];
    assert.ok(file, `The native review patch must contain ${name}`);
    const added = file.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++ ")).map(line => line.slice(1)).join("\n") + "\n";
    const original = (await readFile(new URL(`../src/${name}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
    assert.equal(added, original);
  }
});
