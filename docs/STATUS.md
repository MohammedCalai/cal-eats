# Calai Eats handover

Updated: 2026-10-24 (Europe/London).

## Current state
Empty folder inspected. Node 24.19.0, npm 11.17.0 and Git available. Built-in SQLite successfully opened in memory. Docker absent; Python launcher unavailable. No existing repository, credentials or app files found. No attached worktree. Agent tools explicitly support `gpt-5.6-sol`.

Foundation implemented by `gpt-5.6-sol`, reviewed by lead. API contracts updated after user explicitly required delivery in the first demo (2026-10-24). Next: delivery-inclusive backend journey, then role-based web interfaces. Full product specification still missing; GBP and commission base remain provisional.

## Completion evidence
Foundation agent ran `npm run db:migrate`, `npm run db:seed` twice (stable 4 users / 2 restaurants / 2 memberships), and `npm run check` (6 passing tests including real loopback HTTP). Lead reviewed source and requested fixes for money precision, all-write Origin validation, bounded IP rate limiting and cookie time consistency; agent implemented fixes. No production/external operations.

## Constraints
Local only. No GitHub/Expo operations, paid provisioning, live payments or existing Calai systems. No usage/cost claims unless actual metering is exposed.
