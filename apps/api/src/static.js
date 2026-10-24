import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/model.js", ["model.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/assets/calai-original.png", ["assets/calai-original.png", "image/png"]],
  ["/assets/food-demo.png", ["assets/food-demo.png", "image/png"]]
]);

export async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
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
