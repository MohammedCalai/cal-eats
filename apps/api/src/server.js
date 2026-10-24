import { createServer as createHttpServer } from "node:http";

export function createServer(app) { return createHttpServer(app); }

export async function listen(server, config) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.hostname, resolve);
  });
  return server.address();
}

export async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
