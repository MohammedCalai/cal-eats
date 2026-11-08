import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

test("public deletion requests remain accessible without sign-in or the app and link exact approved legal copies", async () => {
  const version = "2026-11-08-v1", approvedAt = "2026-11-08T00:00:00.000Z";
  const documents = Object.fromEntries(["terms", "privacy"].map(kind => {
    const archiveFile = `customer-${kind}-${version}.txt`, text = readFileSync(new URL(`../legal-documents/${archiveFile}`, import.meta.url), "utf8");
    return [kind, { archiveFile, version, sha256: createHash("sha256").update(text).digest("hex"), url: `/legal/${kind}/${version}`, approvedAt, effectiveAt: approvedAt, approvalReference: "Isolated HTTP fixture for already approved document copies" }];
  }));
  const f = await journeyFixture({ now: () => new Date("2026-11-09T12:00:00.000Z"), customerLegal: { enabled: true, documents } });
  try {
    f.config.runMode = "hosted-preview";
    for (const path of ["/account-deletion", "/account-deletion/"]) {
      const page = await f.request(path);
      assert.equal(page.status, 200, page.text);
      assert.match(page.headers.get("content-type"), /^text\/html/);
      assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
      assert.match(page.text, /Delete your Cal-Eats account/);
      assert.doesNotMatch(page.text, /<form\b|<script\b|data-auto-download=/);
      assert.match(page.text, /do not need to reinstall the app/);
      assert.match(page.text, /one-calendar-month legal deadline/);
      const links = [...page.text.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
      for (const link of new Set(links.filter(link => link.startsWith("/")))) {
        assert.equal((await f.request(link)).status, 200, `Public resource unavailable: ${link}`);
      }
      const email = links.find(link => link.startsWith("mailto:") && link.includes("?subject="));
      assert.ok(email, "Deletion must be requestable without logging in");
      const destination = new URL(email);
      assert.equal(destination.pathname, "support@calai.info");
      assert.equal(destination.searchParams.get("subject"), "Cal-Eats account deletion request");
      assert.equal(destination.searchParams.has("body"), false, "No personal information is embedded in the email link");
    }
    const head = await f.request("/account-deletion/", { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.text, "");
    assert.equal((await f.request("/account-deletion/", { method: "POST", body: {} })).status, 403);
    for (const kind of ["privacy", "terms"]) {
      const copy = await f.request(`/legal/${kind}/${version}.txt`);
      assert.equal(copy.status, 200);
      assert.equal(createHash("sha256").update(copy.text).digest("hex"), documents[kind].sha256);
      assert.match(copy.headers.get("cache-control"), /immutable/);
    }
    const support = await f.request("/support/");
    assert.match(support.text, /href="\/account-deletion\/"/);
    assert.doesNotMatch(support.text, /before closing your login/);
  } finally { await f.close(); }
});
