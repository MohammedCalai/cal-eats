# Customer website and app downloads

The hosted customer entry at `/order/` presents the branded download page. The
public landing page links to `/download/`; it does not offer customer web login.
`/support/` is a public contact/help page, without a login requirement.

Both public download channels are unavailable by default. No invited TestFlight
or Google Play internal-testing links are exposed. Public release is a separate
operator decision: confirm the listing is publicly installable before setting
its availability flag and URL in the Cal-Eats service environment.

| Setting | Default | Purpose |
| --- | --- | --- |
| `CALAI_IOS_PUBLIC_APP_AVAILABLE` | `false` | Explicitly enables the verified public iPhone/iPad listing |
| `CALAI_IOS_PUBLIC_APP_URL` | unset | HTTPS Apple listing for app ID `6831180948` |
| `CALAI_ANDROID_PUBLIC_APP_AVAILABLE` | `false` | Explicitly enables the verified public Android listing |
| `CALAI_ANDROID_PUBLIC_APP_URL` | unset | HTTPS Google Play listing for `uk.co.calai.caleats` |

Only the exact store domains and Cal-Eats app identifiers are accepted. Internal
invitation URLs, other apps, credentials, extra query fields and fragments are
rejected. `/app-downloads.json` exposes only the availability booleans and public
URLs with `Cache-Control: no-store`.

When a platform is enabled, `/download/` and the hosted `/order/` gate detect
Android, iPhone and iPad (including the desktop-style iPad user agent), and open
that platform’s public listing. Desktop users choose an available store button.
No incoming query string, account token or order identifier is forwarded to a
store. An unavailable platform stays on the page with “Available soon”.

The local customer preview remains available in local run mode. Hosted password
reset and email verification fragments move to `/account-access/`, staying in the
fragment. Checkout return URLs and restaurant application URLs keep their web
flow. Business/admin login, API routes, receipts and future legal pages are not
redirected by this gate. Preserving a route does not create or approve a legal
policy page.

Customer web reminders are silent. Unread updates produce one non-modal reminder
with View and Close actions. Polling does not recreate it; closing acknowledges
attention locally without marking the underlying updates read. The reminder
waits while a chat, basket, checkout or modal is open, or the page is hidden.
Business order alert sounds are unchanged.
