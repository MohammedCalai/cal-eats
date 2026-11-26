import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { serveStatic } from "../src/static.js";

test("public customer and restaurant pages have direct routes and self-hosted map assets", async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (!await serveStatic(req, res, pathname, { runMode: "hosted-preview" })) {
        res.writeHead(404).end();
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [route, headline] of [["/customers", "0% SERVICE FEE"], ["/customers/", "0% SERVICE FEE"], ["/restaurants", "FREE TABLET + FREE PRINTER"], ["/restaurants/", "FREE TABLET + FREE PRINTER"]]) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), /^text\/html/, route);
      assert.match(response.headers.get("content-security-policy"), /default-src 'self'/, route);
      assert.ok((await response.text()).includes(headline), route);
      const head = await fetch(origin + route, { method: "HEAD" });
      assert.equal(head.status, 200, route);
      assert.equal((await head.text()), "", route);
      assert.equal(head.headers.get("content-length"), response.headers.get("content-length"), route);
    }
    const customerResponse = await fetch(origin + "/customers/");
    const customer = await customerResponse.text();
    assert.match(customerResponse.headers.get("content-security-policy"), /connect-src 'self' https:\/\/tiles\.openfreemap\.org/);
    assert.match(customerResponse.headers.get("content-security-policy"), /worker-src 'self'/);
    assert.match(customer, /id="coverage-map"/);
    assert.doesNotMatch(customer, /First planned area|data-district=|id="coverage-svg"/);
    const restaurant = await (await fetch(origin + "/restaurants/")).text();
    assert.match(restaurant, /href="https:\/\/eats\.calai\.info\/order\/\?view=register-restaurant"/);
    const restaurantResponse = await fetch(origin + "/restaurants/");
    assert.doesNotMatch(restaurantResponse.headers.get("content-security-policy"), /tiles\.openfreemap\.org/);
    const worker = await fetch(origin + "/assets/maplibre-gl-worker.mjs", { method: "HEAD" });
    assert.match(worker.headers.get("content-security-policy"), /connect-src 'self' https:\/\/tiles\.openfreemap\.org/);
    for (const [route, type] of [["/coverage-map.js", /^text\/javascript/], ["/assets/lu-districts.geojson", /^application\/geo\+json/], ["/assets/maplibre-gl.mjs", /^text\/javascript/], ["/assets/maplibre-gl-worker.mjs", /^text\/javascript/], ["/assets/maplibre-gl.css", /^text\/css/]]) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), type, route);
    }
    assert.equal((await fetch(origin + "/assets/uk-outline.geojson")).status, 404);
    const districts = await (await fetch(origin + "/assets/lu-districts.geojson")).json();
    assert.deepEqual(districts.features.filter(feature => feature.properties.highlighted).map(feature => feature.properties.name).sort(), ["LU1", "LU2", "LU3", "LU4", "LU5", "LU6", "LU7"]);
    assert.equal((await fetch(origin + "/customers/not-a-page")).status, 404);
  } finally {
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
