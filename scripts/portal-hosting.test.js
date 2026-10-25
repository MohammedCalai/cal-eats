import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { serveStatic } from '../apps/api/src/static.js';

async function serve(pathname, method = 'GET') {
  const headers = {};
  const response = { status: 0, body: null, setHeader(name, value) { headers[name.toLowerCase()] = value; }, writeHead(status, values) { this.status = status; for (const [key, value] of Object.entries(values)) headers[key.toLowerCase()] = value; }, end(body) { this.body = body; } };
  const handled = await serveStatic({ method }, response, pathname);
  return { handled, ...response, headers };
}

test('portal hosting refuses traversal, source files and unknown route fallbacks', async () => {
  for (const pathname of ['/business/../package.json', '/business/%2e%2e/package.json', '/business/%5c..%5cpackage.json', '/business/.env', '/business/assets/main.js.map', '/business/source/private']) {
    assert.equal((await serve(pathname)).handled, false, pathname);
  }
  const redirect = await serve('/business');
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/business/');
});

test('landing and ordering are distinct public entries with working assets and HEAD', async () => {
  const home = await serve('/');
  assert.equal(home.status, 200);
  assert.match(home.body.toString(), /action="\/order\/"/);
  assert.match(home.body.toString(), /href="\/business\/login"/);
  const order = await serve('/order/');
  assert.equal(order.status, 200);
  assert.match(order.body.toString(), /id="customer-bottom"/);
  for (const pathname of ['/landing.css', '/landing.js', '/order/']) {
    const head = await serve(pathname, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
  }
  assert.equal((await serve('/order/.env')).handled, false);
});

test('built portal supports deep links and HEAD without leaking authenticated content', { skip: !existsSync(new URL('../apps/portal/dist/index.html', import.meta.url)) }, async () => {
  const response = await serve('/business/owner/earnings');
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /\/business\/assets\//);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  const head = await serve('/business/admin/refunds', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);
});
