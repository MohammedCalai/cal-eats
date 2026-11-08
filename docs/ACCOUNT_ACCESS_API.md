# Account access and customer signup email

Every new web or native customer signup now creates one combined welcome and email-verification message. Local mode saves it in the private SQLite mailbox without contacting a provider. Hosted mode commits a hashed token and encrypted email queue entry, then the existing account-email worker dispatches through the approved service mailbox. Provider acceptance does not prove arrival in the inbox. No raw token is returned in an API response.

Migration 50 adds `email_verification_required`, defaulting to zero for existing accounts. Both customer signup routes explicitly set it to one. Existing customers remain able to order without a new verification requirement. New customers may sign in, browse, contact support and use privacy controls while verification is pending; new order creation returns `428 EMAIL_VERIFICATION_REQUIRED` before any order, payment, offer or voucher mutation. Existing successful order replays are checked first and remain recoverable.

Hosted signup fails with `503 SIGNUP_EMAIL_UNAVAILABLE` before account creation when approved secure mail transport or encryption material is unavailable. Signup, legal acceptance, verification token, welcome queue and session share one database transaction; queue failure rolls the entire signup back. Registration performs no network send inside that transaction.

All responses use the existing `{data: ...}` or `{error: ...}` envelope. Existing exact Host/Origin rules, body limits and auth throttling apply.

- `POST /api/auth/password/forgot` with `{email}` returns `202 {data:{accepted:true,delivery}}` for both known and unknown valid addresses.
- `POST /api/auth/password/reset` with `{token,password}` returns `200 {data:{passwordReset:true}}`. Tokens are high-entropy, stored only as hashes in the access-token table, expire after 30 minutes, and are single use. Success consumes every outstanding password-reset token for that user and revokes all sessions. It does not create a session.
- `GET /api/auth/email-verification/status` requires authentication and returns `{data:{email,emailVerified,verificationRequired,canOrder,resendAvailableAt,delivery}}`. `verificationRequired` means a new customer is still unverified. `delivery` is `local_simulation`, `email` or `unavailable`.
- `POST /api/auth/email-verification/send` with `{}` requires authentication and returns `202 {data:{accepted:true,resent,...status}}`. Resending is throttled and has a persisted 60-second cooldown per account/email. A cooldown response has `resent:false`, a future `resendAvailableAt`, and creates no extra token or email. Concurrent resend clicks create at most one new message. A successful resend supersedes older links. Verified accounts are not sent another verification email.
- `POST /api/auth/email-verification/confirm` with `{token}` returns `200 {data:{emailVerified:true}}`. Success marks only the account bound to that token/email verified and consumes its outstanding verification tokens. Links expire after 24 hours and can be used once. The public `/order/#verify-email=<token>` link must show an explicit confirmation button; GET requests never consume the token, so email link scanners do not verify an account.
- Native aliases are `/api/native/auth/email-verification/status`, `/send` and `/confirm`. Signup responses include `emailVerification` with the status shape above; the existing public user object is unchanged.
- `GET /api/account` includes `emailVerified` and `emailVerifiedAt`. In local mode these reflect only a simulated confirmation, not real email delivery.

Invalid, expired, replayed, superseded or concurrently consumed confirmation/reset tokens return `400 TOKEN_INVALID`. Email changes clear verification, permanently consume old access tokens and cancel pending stale dispatches. Changing the email back does not revive a link. Raw tokens and mail bodies are excluded from API responses, errors, logs and account exports.

Local messages are stored in the private `local_mail_sink` SQLite table. They can be inspected only by an explicit local command:

```powershell
node apps/api/scripts/mailbox.js --db data/calai-eats.sqlite
```

The command prints locally generated links containing their one-time token. Treat this output like a password and do not publish it.
