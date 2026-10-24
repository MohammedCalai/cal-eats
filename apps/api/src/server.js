import { createServer as createHttpServer } from "node:http";

const activeHandlers = new WeakMap();
export function createServer(app) {
  const active = new Set();
  const server = createHttpServer((req, res) => {
    const pending = Promise.resolve().then(() => app(req, res));
    active.add(pending);
    pending.catch(() => { if (!res.headersSent) { res.statusCode = 500; res.end(); } else res.destroy(); }).finally(() => active.delete(pending));
  });
  activeHandlers.set(server, active);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function listen(server, config) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.hostname, resolve);
  });
  return server.address();
}

export async function closeServer(server, { graceMs = 5_000 } = {}) {
  const active = activeHandlers.get(server) ?? new Set();
  let closeResult = Promise.resolve();
  if (server.listening) closeResult = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeIdleConnections?.();
  const deadline = Date.now() + graceMs;
  while (active.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
  if (active.size) { server.closeAllConnections?.(); return { drained: false, pendingHandlers: active.size }; }
  server.closeAllConnections?.(); await closeResult;
  return { drained: true, pendingHandlers: 0 };
}
