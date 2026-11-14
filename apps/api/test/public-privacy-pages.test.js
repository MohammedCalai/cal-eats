import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { journeyFixture } from "./helpers.js";

const version = "2026-11-08-v1", stamp = "2026-11-08T00:00:00.000Z";
const hashes = { terms: "b20a70bce474651c3d3e67a92a6391dd5030244b7a8069df0cb4ea9bd29490f1", privacy: "eb363ca14c8dde6bda1c934d6b412386eaa567d9ac1cad6ec9384366bba425c7" };
const documents = Object.fromEntries(Object.keys(hashes).map(kind => [kind, { archiveFile: `customer-${kind}-${version}.txt`, version, sha256: hashes[kind], url: `/legal/${kind}/${version}`, approvedAt: stamp, effectiveAt: stamp, approvalReference: "Isolated public-information regression fixture for approved policy copies" }]));

test("public privacy and applicant information stays accessible without the app, with safe GET/HEAD routes and complete local links", async () => {
  const f = await journeyFixture({ now: () => new Date("2026-11-14T12:00:00.000Z"), customerLegal: { enabled: true, documents } });
  try {
    f.config.runMode = "hosted-preview";
    const before = f.db.prepare("SELECT * FROM customer_legal_documents ORDER BY kind,version").all();
    for (const route of ["/privacy-security", "/privacy-security/", "/business-applicant-privacy", "/business-applicant-privacy/"]) {
      const response = await f.request(route, { headers: { "user-agent": "Mozilla/5.0 (iPhone)" } });
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), /^text\/html/);
      assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
      assert.equal(response.headers.get("set-cookie"), undefined);
      assert.doesNotMatch(response.text, /<script\b|data-auto-download=|<form\b/);
      assert.match(response.text, /support@calai\.info/);
      const head = await f.request(route, { method: "HEAD" });
      assert.equal(head.status, 200); assert.equal(head.text, "");
      assert.equal(head.headers.get("content-length"), response.headers.get("content-length"));
      for (const link of new Set([...response.text.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]).filter(x => x.startsWith("/")))) {
        const parsed = new URL(link, f.config.origin), target = await f.request(parsed.pathname);
        if (/^\/legal\/(terms|privacy)$/.test(parsed.pathname)) {
          assert.equal(target.status, 302); assert.equal(target.headers.get("location"), `${parsed.pathname}/${version}`);
          assert.equal((await f.request(target.headers.get("location"))).status, 200);
        } else assert.equal(target.status, 200, `Broken public resource: ${link}`);
        if (parsed.hash) assert.ok((target.text.match(/\bid="([^"]+)"/g) || []).some(value => value === `id="${parsed.hash.slice(1)}"`), `Missing fragment ${link}`);
      }
      assert.equal((await f.request(route, { method: "POST", body: {} })).status, 403);
    }
    const root = await f.request("/privacy-security/");
    assert.match(root.text, /CALAI LTD/); assert.match(root.text, /16995419/);
    assert.match(root.text, /62 Cades Close/); assert.match(root.text, /England and Wales/);
    assert.match(root.text, /30 days/);
    assert.deepEqual(f.db.prepare("SELECT * FROM customer_legal_documents ORDER BY kind,version").all(), before);
    for (const kind of Object.keys(hashes)) {
      const archived = await f.request(`/legal/${kind}/${version}.txt`);
      assert.equal(archived.status, 200);
      assert.equal(createHash("sha256").update(archived.bodyBuffer).digest("hex"), hashes[kind]);
      assert.equal(createHash("sha256").update(readFileSync(new URL(`../legal-documents/customer-${kind}-${version}.txt`, import.meta.url))).digest("hex"), hashes[kind]);
    }
  } finally { await f.close(); }
});

test("public entry pages expose current policies, company details and a proportionate complaint route", async () => {
  const f = await journeyFixture();
  try {
    for (const route of ["/", "/download/", "/support/", "/account-deletion/"]) {
      const { status, text } = await f.request(route);
      assert.equal(status, 200);
      const footer = text.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)?.[0];
      assert.ok(footer, route);
      for (const link of ["/legal/terms", "/legal/privacy", "/privacy-security/"]) assert.ok(footer.includes(`href="${link}`), `${route} missing ${link}`);
      assert.match(footer, /CALAI LTD/); assert.match(footer, /16995419/); assert.match(footer, /62 Cades Close/);
    }
    const support = (await f.request("/support/")).text;
    assert.match(support, /case.by.case|reviewed individually/i);
    assert.match(support, /evidence/i);
    assert.match(support, /statutory|legal rights/i);
    assert.doesNotMatch(support, /we guarantee.*refund|no refunds under any circumstances|photo is required/i);
  } finally { await f.close(); }
});
