# Repository release preparation

Calai Eats currently runs as a **local preview**. The repository includes a guarded hosted-preview profile, container recipe and phone installation assets. No hosting operation has occurred; live payments, external email and other provider integrations are not enabled. See HOSTED_PREVIEW.md, CONTAINER_PREVIEW.md and PHONE_INSTALL.md for the precise remaining environment checks.

## Supported local toolchain

- Node.js `24.19.0` (`.nvmrc`)
- npm `11.17.0` (`packageManager` and `engines` in `package.json`)
- npm workspaces: `apps/api`, `apps/web`, and `packages/contracts`

The API entry point is `apps/api/src/main.js`. It serves the browser app from `apps/web` on the same local origin. The contracts package is linked as a workspace dependency through its matching `0.1.0` version. `package-lock.json` is the installation lock and should be committed whenever workspace metadata changes.

## Prepare the repository

From the repository root:

```powershell
npm install --package-lock-only --ignore-scripts --offline
npm run release:check
```

The release check is intentionally inexpensive: it checks JavaScript syntax, required packaging files, lock metadata and the tracked upload set. It does not start the service, seed data, create a backup, contact a provider or publish anything.

Before upload, inspect the exact set of files Git will include:

```powershell
git status --short
git diff --check
git ls-files
```

Keep `.env`, databases, backups, logs, local mail, generated archives and other local artifacts out of the repository. Only `.env.example` belongs in the upload. If an ignored file was tracked previously, remove it from the Git index while retaining the local copy, then inspect `git status` again.

## Upload to GitHub later

Repository upload is separate from running the backend. Stop and review local changes, choose the intended GitHub repository and visibility, then commit and push through the normal Git workflow. No workflow in this repository uploads automatically.

Do not use GitHub Pages for the complete application: Pages only hosts static files and cannot run this Node.js API, cookie sessions or SQLite database. A later production plan must choose an appropriate API host, persistent data service, secrets management, HTTPS configuration and provider integrations before public use.

After cloning on another trusted machine, use the pinned Node/npm versions, install from the committed lockfile, copy `.env.example` to an untracked `.env`, and follow `docs/LOCAL_RUNBOOK.md` for the local preview. The npm start and database scripts load that file through Node's `--env-file-if-exists` option. Never copy a live local database into GitHub.
