# Hosted container preview

These files define the guarded **hosted preview**, not a production release. The existing Cal-Eats Railway service is deployed; current store and release limits are recorded in [store submission readiness](STORE_SUBMISSION_READINESS_2026_11_08.md). A local Docker image build is not claimed here.

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

## Dependency-based deployment watch paths

On 8 November 2026, only `watchPatterns` was updated on the existing Cal-Eats Railway service. Configuration readback matched these sixteen patterns, with no staged changes. The running backend remained deployment `d49e0aff-00fc-443e-b983-f03425d3ee79`, status `SUCCESS`, application source `354a593714e10a1dad9cfb52d4c4df5780df21c7`. This identifies the hosted backend; it does not establish Android 22 installation, device verification or public store availability.

Railway evaluates these patterns from the repository root, even if a service has a Root Directory setting. A push with no matching changed path should skip creating a deployment:

```text
/Dockerfile
/.dockerignore
/.gitattributes
/package.json
/package-lock.json
/apps/*/package.json
/apps/api/**
/apps/web/**
/apps/portal/**
/apps/print-bridge/**
/packages/**
/infra/**
/scripts/**
/.railway/**
/railway.json
/railway.toml
```

The patterns cover the API, hosted customer web assets, compiled business/admin portal inputs, shared contracts, downloadable printer-bridge files, container operations and packaged backup/restore scripts. Root and workspace package manifests plus the shared lockfile remain watched because the Docker build installs npm workspaces. Changes to native app dependencies can therefore still legitimately trigger a backend build; native-only screen, asset or release-evidence edits should not.

`docs/**` is already excluded from the Docker context by `.dockerignore` and is not read as published legal content. The approved runtime document bytes are under `apps/api/legal-documents/**`, loaded by the API and covered by `/apps/api/**`. Do not move a runtime document or other build dependency outside the watched paths without updating this policy in the same change. Dockerfile, ignore-file and infrastructure changes remain watched so packaging changes receive review.

These settings are held on the existing service through the supported Railway configuration interface. No new legacy `railway.json` or `railway.toml` descriptor was introduced; watching those filenames does not recommend using the retired format. Roll back filtering by clearing the existing service's configured Watch Paths, then verify configuration readback before relying on broad push-triggered deployments again.

Configuration readback and the unchanged running deployment were verified when this policy was saved. Subsequent documentation/native-only pushes must be checked against Railway deployment history, with the exact repository head and running backend recorded separately in the private operational checkpoint; configuration alone does not prove that a build was skipped. This filtering does not reduce the running service's baseline resource usage or suppress deliberate manual deployments, service-setting changes or restarts.

The service worker owns only caches named `calai-public-*`. API requests and page navigations always use the network; an offline navigation receives only the public reconnect page. Public scripts, styles and images use network-first refreshes with a versioned cache fallback. Increment the cache version when the offline asset set changes so old Calai cache entries are removed during activation. Authenticated HTML, API data, orders, mail and receipts must never be added to `PUBLIC`.

The hosted preview hides seeded-account shortcut buttons, requires exact-origin writes, keeps simulated payments, and displays a persistent preview banner. It is not a production security or scaling model.

References: [Dockerfile reference](https://docs.docker.com/reference/dockerfile/), [Docker build best practices](https://docs.docker.com/build/building/best-practices/), [Railway watch paths](https://docs.railway.com/builds/build-configuration#configure-watch-paths), [Railway Infrastructure as Code reference](https://docs.railway.com/infrastructure-as-code/reference), [Railway health checks](https://docs.railway.com/deployments/healthchecks), and [Railway volumes](https://docs.railway.com/volumes/reference).
