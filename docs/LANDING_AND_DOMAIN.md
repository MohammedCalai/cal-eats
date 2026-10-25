# Landing page and existing domain

25 October 2026. The user owns `calai.info` and does not want another domain purchase. The proposed independent Cal-Eats hostname is `eats.calai.info`; this is a deployment plan, not a configured address. Do not alter the original Calai application, repository, apex or existing subdomain records.

## Local routes

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
