# Landing page and existing domain

25 October 2026. The user owns `calai.info` and does not want another domain purchase. The proposed independent Cal-Eats hostname is `eats.calai.info`; this is a deployment plan, not a configured address. Do not alter the original Calai application, repository, apex or existing subdomain records.

## Local routes

### Hosted preview live — 25 October 2026

Final access update: user approved administrator email `mohammed.sabbir1707@gmail.com` and local random-password file. Account created via SSH/stdin as node and live admin login/role verified; browser dashboard opened. User supplied `yankeefga07@gmail.com` for business; separate owner account registered and login verified, with unpublished pending restaurant `Cal-Eats Preview Kitchen`. Both random passwords are in ignored `artifacts/preview-admin-access.txt`; never commit or print that file. The pending restaurant has no menu/address/hours yet and must not be published until ready. Public HTTPS health returned ready/database ready/migrations current. Usage stop threshold is now 1% remaining. Earlier pending-admin/3% statements below are historical and superseded. Dedicated SSH setup key is registered as `cal-eats-preview-setup`, local key `C:\Users\hello\.ssh\cal-eats-preview-setup`; private key is not in repository. CLI sign-in persists with user-approved selected workspace/project access.

This update supersedes the pending deployment notes below. The user approved `MohammedCalai/cal-eats`, existing-plan Railway app/storage charges, both exact IONOS DNS additions and the scoped Railway CLI connection. Private repository created and pushed; original Calai repository/account untouched. Railway project `50e241b0-71ad-4580-81e2-085f70fd4230`, preview environment `d47697b7-6e84-4f14-bfb0-f6d1cd707621`, service `bb3061c2-54f1-420a-b598-03783d5195c3`, volume `fce14737-581d-477b-b1d5-ab18c21b8e3a`. Single Europe replica, 0.5 CPU/500 MB, 1000 MB `/data`, no overlap. Origin `https://eats.calai.info`, simulated payments, empty freshly migrated database. No demo database uploaded.

Deployment `0d41358e-7872-4126-bcfe-bb29f9a5340b` succeeded at commit `c620bca`. Railway rejected Docker VOLUME; it was removed because storage is platform-managed. A short root entrypoint fixes ownership of the newly mounted /data directory then executes the app as node via gosu. HTTP HTTPS health/ready returned database ready/migrations current and browser opened the live landing. Screenshot `artifacts/screenshots/51-live-landing-phone.jpg`.

IONOS added only CNAME `eats` → `x1dc6td1.up.railway.app` and TXT `_railway-verify.eats` with the exact Railway ownership value, both TTL3600. Original records unchanged. CLI signed in and dedicated key `cal-eats-preview-setup` registered; SSH works. Initial administrator still NOT created: automatic review requires user approval of inferred email `mohammed.sabbir1707@gmail.com` and random-password delivery in an ignored local file. That question is pending. Admin bootstrap must run as `gosu node node apps/api/scripts/bootstrap-admin.js` with the password on stdin. Business user must then register and be approved. Do not claim either account exists yet. Landing still contains local/sample preview wording, which needs updating for the empty hosted database. Runtime Docker health probe can also be switched explicitly to gosu node on next code update.

User changed usage stop threshold from 5% to 3% remaining. Last observed at this update: 4%. Preserve this stop constraint.

25 October deployment preparation: the user approved the new private repository `MohammedCalai/cal-eats` and a separate Cal-Eats Railway preview. The connected Railway account is `mohammedcalai`; it currently has only unrelated staging projects. The IONOS DNS filter confirmed there is no `eats` record. No DNS or Railway resource has been changed. Project creation was blocked by automatic approval review pending explicit consent to existing-plan hosting charges. The browser is signed into the original GitHub account; the new-account sign-in handoff is pending. Never create the repository under `calai-operation`.

Logo update: the reattached Cal-Eats artwork now replaces the reconstructed wordmark across landing, customer browser, portal and native source. The user requested removal of “Save more on every order”; the supplied design was edited for that request and is stored as `assets/cal-eats-logo.png` in web/mobile. Display crops only generated letterboxing. Portal production build and changed JavaScript syntax checks passed; phone screenshot `artifacts/screenshots/45-logo-no-tagline-phone.jpg` verifies the served landing. Public cache version is v7. Delivery fees were not changed.

- `/`: responsive public landing with the original blue emblem, Luton launch copy, postcode search, restaurant section and FAQ.
- `/order/`: existing customer browser app. Landing postcode submissions initialise discovery; `?view=account` opens account/sign-in and `?view=register-restaurant` opens the existing pending restaurant application form.
- `/business/`: role-controlled restaurant/admin portal.
- `/api/`: shared backend, still isolated from original Calai.

All links and public assets use this same origin. No tracker, analytics service, marketing-mail capture or third-party assets were added. Old root-fragment password/email links are forwarded locally to `/order/`, where the existing app consumes and removes the fragment. New links and PWA launches use `/order/`. The preview retains `noindex` and sample-data disclosures; review these and final marketing/legal copy before a real launch.

## Later domain connection

When separately authorised, first verify control of the existing DNS zone and whether `eats` is unused. Provision an independent Cal-Eats hosting service and HTTPS certificate, then add only the exact hostname's required DNS record. Do not change nameservers, apex/www/MX records or any original Calai service. Configure `CALAI_ORIGIN=https://eats.calai.info` on that independent deployment and keep authentication cookies host-only.

No additional domain registration is required for a subdomain. Hosting and provider services may still have costs. DNS targets cannot be filled in until the hosting destination exists. [Subdomain DNS and HTTPS guidance](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/).

The native app currently rejects the original domain and all its subdomains by design. Before an independently verified Cal-Eats deployment is used by native clients, narrowly permit only the approved new hostname and its origin; retain the ban on original Calai hosts. Do not relax that safeguard merely because the domain has been named in a plan.

## Launch work still outstanding

Complete provider-created payment/payout/refund and cash-commission orchestration; real account-mail delivery; signed iPhone/Apple Pay and physical tablet/printer verification; reviewed terms, privacy and retention; independent hosting, secrets, backups, monitoring and rollback. A PostgreSQL/multi-node migration is a later scale decision, not something proved by the short local load run. Detailed software and external gates remain in `EXPANSION_ACCEPTANCE.md`.
