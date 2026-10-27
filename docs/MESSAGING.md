# Order messaging

Order messaging is scoped to a single order between its customer and any current staff member of its restaurant. Messages may be sent while an order is active and for a restaurant-configured support window after completion or rejection. The default is two hours and the hard maximum is 24 hours.

## API

- `GET /api/orders/:orderId/messages?before=<ISO>&beforeId=<UUID>&limit=50`
- `POST /api/orders/:orderId/messages` with `Idempotency-Key` (or `clientMessageId`) and `{ "message": "...", "clientMessageId"?: "..." }` (1–300 characters)
- `POST /api/orders/:orderId/messages/read` with `{ "lastMessageId": "..." }`
- `GET|PATCH /api/restaurant/restaurants/:restaurantId/message-settings`; updates require an owner and exactly six quick responses.
- `POST /api/orders/:orderId/message-incidents` lets an order participant submit a bounded, rate-limited concern without copying chat content.
- `GET /api/admin/message-incidents` and `PATCH /api/admin/message-incidents/:id` provide an audited metadata review lifecycle (`reported`, `under_review`, `resolved`).
- `GET /api/notifications/stream` is an authenticated SSE feed. Reconnection uses the standard `Last-Event-ID` header. Notifications deliberately contain no chat text.

Administrators cannot send messages. Reading message content requires an explicit `reason` query value of 10–300 characters and creates an audit event. Unauthorized access is reported as not found.

## Encryption and retention

Message bodies use AES-256-GCM with a fresh 96-bit nonce and authenticated metadata binding the message, order, sender, timestamps and key version. Hosted preview requires an explicit base64 32-byte `CALAI_MESSAGE_ENCRYPTION_KEY`; a missing or malformed key disables messaging without disabling the rest of the service. Local mode creates `.cal-eats-message-key` beside the SQLite database with private file permissions, or uses the configured `CALAI_MESSAGE_KEY_FILE`. The key is intentionally outside SQLite and therefore outside database-only backups.

Messages expire exactly 30 days after creation. Reads enforce the expiry even before cleanup runs; `runMessageRetention(db, config)` hard-deletes expired ciphertext and stale rate-limit buckets. Schedule it through the local operations worker and run it after restore. A restored database is unreadable without its matching key, so back up and restore the key separately through an access-controlled secret store. Never place it in a database backup, repository, logs, or screenshots. Removing the key is cryptographic erasure of all retained message bodies.

Incident metadata has a separate operational record lifecycle and is not deleted by the 30-day chat cleanup. It contains the reporter's reason and review status, but never a copied message body, ciphertext, decrypted excerpt, or message encryption key. Incident review does not preserve chat beyond its normal expiry; an administrator who needs retained content must use the separately audited, reason-gated content review before the message expires.

The SSE implementation uses one shared poller per process, bounded per-client buffering, heartbeat comments, durable notification catch-up and account revalidation. A multi-process deployment should replace the in-process wake-up mechanism with shared pub/sub while retaining the durable cursor.
