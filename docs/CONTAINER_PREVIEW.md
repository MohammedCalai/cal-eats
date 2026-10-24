# Future hosted container preview

These files prepare a guarded **hosted preview**, not a production release. No image was built on the current machine because Docker is unavailable, and no Railway project, domain, volume or deployment has been created.

## Container contract

The Dockerfile pins Node.js `24.19.0`, installs only the lockfile's local workspace links with lifecycle scripts disabled, and runs the API as the image's unprivileged `node` user. It stores SQLite at `/data/calai-eats.sqlite`, sends `SIGTERM` to the Node process, and probes `/health/ready` with Node's built-in `fetch`.

Provide these settings manually when a preview is authorized:

- `CALAI_RUN_MODE=hosted-preview`
- `CALAI_HOST=0.0.0.0`
- `CALAI_PORT=4310`
- `PORT=4310` so the platform readiness probe uses the same canonical port
- `CALAI_ORIGIN=https://<exact-preview-host>` with no trailing slash, path or query
- `CALAI_HEALTHCHECK_HOST=healthcheck.railway.app` to allow that hostname only on readiness routes
- `CALAI_DB_PATH=/data/calai-eats.sqlite`
- `NODE_ENV=production`

Attach one persistent volume at `/data`. Keep exactly one replica: SQLite and Railway volumes are not suitable for horizontal replicas. Verify that the mounted directory is writable by the container's `node` user before starting; Railway documents that volumes are mounted as root, so this permission boundary must be resolved and tested without changing the application process to root. Backups and restore checks remain mandatory.

Railway's legacy `railway.json` format cannot be enabled for new services and reaches its documented cutoff on 1 December 2026, so this repository does not include a misleading legacy descriptor. When deployment is separately authorized, connect the repository so Railway detects the root Dockerfile, then configure `/health/ready`, a 60-second health-check timeout, `ON_FAILURE` with at most three retries, no deployment overlap and a ten-second drain through the currently supported Railway UI or a reviewed `.railway/railway.ts` plan. The project name, repository owner, region and volume size are deliberate operator choices and are not guessed here.

Set exactly one region/replica and attach the volume manually. A volume-backed rollout may have brief downtime. Railway's external readiness request uses `healthcheck.railway.app`; the API must allow that hostname only for the readiness route. The image's internal probe remains loopback-only but sends the configured public origin as its `Host` header so strict hosted host checks still apply.

The service worker owns only caches named `calai-public-*`. API requests and page navigations always use the network; an offline navigation receives only the public reconnect page. Public scripts, styles and images use network-first refreshes with a versioned cache fallback. Increment the cache version when the offline asset set changes so old Calai cache entries are removed during activation. Authenticated HTML, API data, orders, mail and receipts must never be added to `PUBLIC`.

The hosted preview hides seeded-account shortcut buttons, requires exact-origin writes, keeps simulated payments, and displays a persistent preview banner. It is not a production security or scaling model.

References: [Dockerfile reference](https://docs.docker.com/reference/dockerfile/), [Docker build best practices](https://docs.docker.com/build/building/best-practices/), [Railway Infrastructure as Code reference](https://docs.railway.com/infrastructure-as-code/reference), [Railway health checks](https://docs.railway.com/deployments/healthchecks), and [Railway volumes](https://docs.railway.com/volumes/reference).
