import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const portalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../portal/dist");
const portalTypes = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".webmanifest", "application/manifest+json; charset=utf-8"], [".png", "image/png"], [".svg", "image/svg+xml"], [".wav", "audio/wav"]]);
const assets = new Map([
  ["/", ["landing.html", "text/html; charset=utf-8"]],
  ["/order", ["index.html", "text/html; charset=utf-8"]],
  ["/order/", ["index.html", "text/html; charset=utf-8"]],
  ["/landing.css", ["landing.css", "text/css; charset=utf-8"]],
  ["/landing.js", ["landing.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/customer-ui.js", ["customer-ui.js", "text/javascript; charset=utf-8"]],
  ["/checkout-attempt.js", ["checkout-attempt.js", "text/javascript; charset=utf-8"]],
  ["/discovery-model.js", ["discovery-model.js", "text/javascript; charset=utf-8"]],
  ["/discovery-ui.js", ["discovery-ui.js", "text/javascript; charset=utf-8"]],
  ["/location-ui.js", ["location-ui.js", "text/javascript; charset=utf-8"]],
  ["/location-client.js", ["location-client.js", "text/javascript; charset=utf-8"]],
  ["/location-ui.css", ["location-ui.css", "text/css; charset=utf-8"]],
  ["/menu-sections.js", ["menu-sections.js", "text/javascript; charset=utf-8"]],
  ["/restaurant-menu.js", ["restaurant-menu.js", "text/javascript; charset=utf-8"]],
  ["/basket-ui.js", ["basket-ui.js", "text/javascript; charset=utf-8"]],
  ["/customer-panels.css", ["customer-panels.css", "text/css; charset=utf-8"]],
  ["/customer-light.css", ["customer-light.css", "text/css; charset=utf-8"]],
  ["/model.js", ["model.js", "text/javascript; charset=utf-8"]],
  ["/live-notifications.js", ["live-notifications.js", "text/javascript; charset=utf-8"]],
  ["/order-messaging.js", ["order-messaging.js", "text/javascript; charset=utf-8"]],
  ["/dispute-resolution.js", ["dispute-resolution.js", "text/javascript; charset=utf-8"]],
  ["/loyalty-ui.js", ["loyalty-ui.js", "text/javascript; charset=utf-8"]],
  ["/customer-additions.js", ["customer-additions.js", "text/javascript; charset=utf-8"]],
  ["/stripe-ui.js", ["stripe-ui.js", "text/javascript; charset=utf-8"]],
  ["/customer-contact.js", ["customer-contact.js", "text/javascript; charset=utf-8"]],
  ["/calai-theme.css", ["calai-theme.css", "text/css; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/offline.html", ["offline.html", "text/html; charset=utf-8"]],
  ["/assets/calai-original.png", ["assets/calai-original.png", "image/png"]],
  ["/assets/cal-eats-logo.png", ["assets/cal-eats-logo.png", "image/png"]],
  ["/assets/food-demo.png", ["assets/food-demo.png", "image/png"]],
  ["/assets/calai-icon.svg", ["assets/calai-icon.svg", "image/svg+xml"]],
  ["/assets/calai-icon-maskable.svg", ["assets/calai-icon-maskable.svg", "image/svg+xml"]]
]);

export async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/business") { res.writeHead(308, { Location: "/business/" }); res.end(); return true; }
  if (pathname.startsWith("/business/")) return servePortal(req, res, pathname);
  const asset = assets.get(pathname);
  if (!asset) return false;
  try {
    const body = await readFile(path.join(webRoot, asset[0]));
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.writeHead(200, { "Content-Type": asset[1], "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function servePortal(req, res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname.slice("/business/".length)); }
  catch { return false; }
  if (relative.includes("\\") || relative.split("/").some(segment => segment === ".." || segment.startsWith("."))) return false;
  // Only generated public assets and explicit client routes are served. Never expose source/maps/config.
  const extension = path.extname(relative);
  let resource = relative;
  if (!extension) {
    if (relative && !/^(login|owner|staff|admin)(\/|$)/.test(relative)) return false;
    resource = "index.html";
  } else if (!portalTypes.has(extension)) return false;
  const absolute = path.resolve(portalRoot, resource);
  if (!absolute.startsWith(portalRoot + path.sep)) return false;
  try {
    const body = await readFile(absolute);
    const offline = resource === "offline-portal.html";
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'${offline ? " 'unsafe-inline'" : ""}; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    res.writeHead(200, { "Content-Type": portalTypes.get(path.extname(resource)), "Content-Length": body.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  } catch (error) { if (error.code === "ENOENT" || error.code === "EISDIR") return false; throw error; }
}
