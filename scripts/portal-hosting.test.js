import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
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

test('landing promotes app downloads and ordering remains a distinct entry with assets and HEAD', async () => {
  const home = await serve('/');
  assert.equal(home.status, 200);
  assert.match(home.body.toString(), /href="\/download\/"/);
  assert.match(home.body.toString(), /data-store="ios"/);
  assert.match(home.body.toString(), /data-store="android"/);
  assert.doesNotMatch(home.body.toString(), /<form[^>]*action="\/order\/"/);
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

test('actual HTTP portal CSP permits only the fixed tablet companion and leaves customer CSP unchanged', { skip: !existsSync(new URL('../apps/portal/dist/index.html', import.meta.url)) }, async () => {
  const server=createServer((req,res)=>{void serveStatic(req,res,new URL(req.url,'http://127.0.0.1').pathname).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(()=>{res.writeHead(500);res.end();});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const pathname of ['/business/owner/dashboard','/business/staff/orders','/business/login']){
      for(const method of ['GET','HEAD']){
        const response=await fetch(origin+pathname,{method});assert.equal(response.status,200,pathname);
        const csp=response.headers.get('content-security-policy'),directives=new Map(csp.split(';').map(value=>{const [name,...sources]=value.trim().split(/\s+/);return[name,sources];}));
        assert.deepEqual(directives.get('connect-src'),["'self'",'http://127.0.0.1:17863']);
        assert.deepEqual(directives.get('script-src'),["'self'"]);assert.deepEqual(directives.get('object-src'),["'none'"]);assert.deepEqual(directives.get('base-uri'),["'none'"]);assert.deepEqual(directives.get('frame-ancestors'),["'none'"]);
        assert.doesNotMatch(csp,/localhost|127\.0\.0\.1:\*|https?:\/\/\*/);await response.arrayBuffer();
      }
    }
    const customerPolicy="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    for(const pathname of ['/','/order/','/download/']){
      const response=await fetch(origin+pathname);assert.equal(response.status,200,pathname);assert.equal(response.headers.get('content-security-policy'),customerPolicy);await response.arrayBuffer();
    }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
