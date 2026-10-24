# Guarded hosted preview

The default remains loopback-only local mode. `CALAI_RUN_MODE=hosted-preview` is a guarded browser preview profile, not a claim of production readiness. It permits binding to `0.0.0.0` only when `CALAI_ORIGIN` is an explicit normalized HTTPS origin. `NODE_ENV=production` is accepted only with hosted preview. Cookies use `Secure`, and every POST, PUT, PATCH and DELETE request must supply the exact configured Origin, including non-browser tools.

The profile uses `CALAI_RUN_MODE=hosted-preview`, `CALAI_HOST=0.0.0.0`, `CALAI_ORIGIN=https://your-host.example` and the existing `CALAI_DB_PATH`. `CALAI_PORT` takes precedence; hosted preview otherwise accepts the platform-provided `PORT`. Local mode ignores `PORT` and defaults to 4310. Do not add a trailing slash or path to the origin.

Railway's health checker uses `Host: healthcheck.railway.app`. Setting `CALAI_HEALTHCHECK_HOST=healthcheck.railway.app` permits that host only for `GET /health/live` and `GET /health/ready`; API, static and write routes retain the configured public Host requirement. No other health-check host value is accepted.

Hosted preview refuses startup when any known demo-account email exists and the demo seed command refuses to run. Payments remain simulated. Real payment providers, managed secrets, multi-instance coordination, proxy-aware client identity and native-app hardening remain future deployment work.

Authentication throttles are persisted in the single SQLite database and survive process restart. Rate identity uses the direct socket address plus submitted identity. Forwarded headers are intentionally ignored; deployments behind a proxy therefore share the proxy socket identity until a separately trusted proxy configuration is designed.

An initial administrator may be created only while the database contains no administrator. The local CLI accepts a masked interactive password or secret input on stdin; passwords are never accepted in arguments, environment variables or logs. Existing accounts are never changed.

```powershell
npm run admin:create -- --db data/preview.sqlite --name "Preview Admin" --email admin@example.test
```

Server shutdown stops accepting connections and allows active request handlers a five-second drain period. SQLite closes only after all handlers finish. If the deadline expires, the process terminates without explicitly closing SQLite so an async handler can never use a prematurely closed connection; the operating system closes the database handle. The application has no database transaction spanning an asynchronous wait. Header, request and keep-alive timeouts are bounded.
