import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { serveStatic } from "../src/static.js";

test("the customer entry point and its local JavaScript imports are served", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      if (!await serveStatic(req, res, new URL(req.url, "http://localhost").pathname)) {
        res.writeHead(404).end();
      }
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pending = ["/app.js"], visited = new Set();
  try {
    while (pending.length) {
      const pathname = pending.shift();
      if (visited.has(pathname)) continue;
      visited.add(pathname);
      assert.ok(visited.size < 100, "Unexpectedly large customer module graph");
      const response = await fetch(origin + pathname);
      assert.equal(response.status, 200, `${pathname} is unavailable`);
      assert.match(response.headers.get("content-type") || "", /javascript/, pathname);
      const source = await response.text();
      const patterns = [
        /(?:^|[;\n])\s*import\s+(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/g,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
        /\bexport\s*\{[^}]*\}\s*from\s*["']([^"']+)["']/g
      ];
      for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
        const dependency = new URL(match[1], origin + pathname);
        if (dependency.origin === origin && dependency.pathname.endsWith(".js")) pending.push(dependency.pathname);
      }
    }
    assert.ok(visited.has("/order-progress.js"), "The shared tracker must be reachable from the customer app");
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
