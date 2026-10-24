# Local account access API

This prerelease flow simulates transactional email inside the local SQLite database. It never contacts an email provider and does not prove that an address can receive real email. Email verification is informational and does not gate ordering.

All responses use the existing `{data: ...}` or `{error: ...}` envelope. Existing exact Host/Origin rules, body limits and auth throttling apply.

- `POST /api/auth/password/forgot` with `{email}` returns `202 {data:{accepted:true}}` for both known and unknown valid addresses.
- `POST /api/auth/password/reset` with `{token,password}` returns `200 {data:{passwordReset:true}}`. Tokens are high-entropy, stored only as hashes in the access-token table, expire after 30 minutes, and are single use. Success consumes every outstanding password-reset token for that user and revokes all sessions. It does not create a session.
- `POST /api/auth/email-verification/send` with `{}` requires authentication and returns `202 {data:{accepted:true}}`. It creates a 24-hour single-use token unless the account is already marked verified.
- `POST /api/auth/email-verification/confirm` with `{token}` returns `200 {data:{emailVerified:true}}`. Success marks the owning account locally verified and consumes its outstanding verification tokens.
- `GET /api/account` includes `emailVerified` and `emailVerifiedAt`. These fields mean only that the local simulated link was confirmed.

Invalid, expired, replayed or concurrently consumed confirmation/reset tokens return `400 TOKEN_INVALID`. Raw tokens and mail bodies are excluded from API responses, errors, logs and account exports.

Local messages are stored in the private `local_mail_sink` SQLite table. They can be inspected only by an explicit local command:

```powershell
node apps/api/scripts/mailbox.js --db data/calai-eats.sqlite
```

The command prints locally generated links containing their one-time token. Treat this output like a password and do not publish it.
