# Customer directory and inbox — 28 October 2026

The business tablet and Cal-Eats Admin phone app share these APIs. Migration 23 adds restaurant-specific customer workflow records, persistent customer conversations, encrypted messages and notification destinations. No original Calai tables, accounts or data are used.

## Directory

`GET /api/restaurant/restaurants/:restaurantId/customers`

Query parameters: `page` (default 1), `pageSize` (default 25, maximum 100), `q` (up to 100 characters), `sort=recent|name|spend|orders`, `segment=all|new|returning|regular|lapsed|vip|needs_attention`, and `status=all|active|follow_up|vip|resolved`.

The response is `{data:{items,pagination,summary,filters,asOf}}`. Pagination includes `page`, `pageSize`, `total`, `totalPages`, `hasNext`, and `hasPrevious`. SQL selects and aggregates only the authenticated restaurant's order history, applies search and filters on the server, and returns one bounded page. Every order has a stable customer-ID tiebreaker. Search treats literal `%` and `_` as text, not wildcard operators. Email can be searched but is not exposed in directory/profile customer DTOs.

Customer rows include `customerId`, `name`, `completedOrderCount`, `totalOrderCount`, `netSpendMinor`, `averageOrderMinor`, `firstOrderAt`, `lastOrderAt`, `workflowStatus`, `engagementStatus`, `segments`, `merchantOffers`, `eligibleForOffers`, `unreadMessageCount`, `activeRefundCaseCount`, and `threadId`. Any customer with own-restaurant order history can receive service support. Monetary metrics count completed, non-fully-refunded orders. Offer eligibility separately requires completed history and marketing consent. New/returning/regular/lapsed segments derive from order history and the restaurant's existing loyalty thresholds. VIP and follow-up are restaurant-specific workflow choices. An unresolved refund, unread customer conversation or follow-up status triggers needs-attention.

`GET /api/restaurant/restaurants/:restaurantId/customers/:customerId/profile` returns `{data:{customer,note,recentOrders,recentOffers,refundCases,conversation}}`. Each history section is bounded to 20 records. `PATCH` at the same path accepts `{workflowStatus,note}`; notes are at most 2,000 characters and status is `active|follow_up|vip|resolved`. Changes are audited without copying the note into the audit payload. Neither an administrator role nor another restaurant can use these owner routes to read an unrelated customer's data.

For aggregate loyalty charts without the old full customer array, use `GET /api/restaurant/restaurants/:restaurantId/loyalty?includeCustomers=false`. Recipient selection should use the bounded directory rather than rendering the legacy analytics array.

## Unified inbox

`GET /api/restaurant/restaurants/:restaurantId/inbox` accepts the same page/search controls plus `status=all|open|awaiting_customer|awaiting_restaurant|resolved` and `unread=true|false`. It returns `{data:{items,pagination,summary}}`.

Rows include `threadId`, `customerId`, `customerName`, `restaurantName`, `status`, `lastMessageAt`, `updatedAt`, `unreadMessageCount`, `conversationType`, `orderId`, and `messagingAvailable`. A `conversationType=customer` row is a persistent restaurant/customer service conversation. A `conversationType=order` row has an `orderId` and uses the existing order-message endpoints and their support window. Closed order chats remain identifiable as resolved history. Inbox lists contain no decrypted message previews; content is loaded only when the participant opens its specific conversation.

## Persistent own-customer conversations

Business owner endpoints:

- `GET /api/restaurant/restaurants/:restaurantId/customers/:customerId/conversation`
- `POST` at the same path with `{message}` and an `Idempotency-Key` header; `clientMessageId` can be supplied as a fallback key.
- `PATCH` at the same path with `{status}` (`open|awaiting_customer|awaiting_restaurant|resolved`).
- `POST /api/restaurant/restaurants/:restaurantId/customers/:customerId/conversation/read` with `{lastMessageId}`.

Customer endpoints:

- `GET /api/customer/conversations` (bounded page/search/status controls).
- `GET|POST /api/customer/conversations/:threadId/messages`.
- `POST /api/customer/conversations/:threadId/read` with `{lastMessageId}`.

Message lists return `{data:{thread,items,unreadCount,nextCursor,readThroughMessageId}}`, with messages in chronological order within the returned page. `limit` defaults to 30 and is capped at 100. An older page uses `before` and `beforeId` from `nextCursor`. Before any message is sent, a conversation lookup can return `thread:null`. Sending creates one thread per restaurant/customer pair. Message DTOs include `id`, `threadId`, `conversationId`, `senderUserId`, `senderRole`, `message`, `createdAt`, `expiresAt`, and `ingestSequence`.

Migration 25 adds a durable per-thread ingestion counter and sequence-based read cursors. Sequence assignment happens inside the persistence transaction after idempotent replay checks, so asynchronous encryption finishing late cannot hide a message behind a timestamp-based read cursor. Clients acknowledge `readThroughMessageId`, the returned page message with the highest ingestion sequence, rather than assuming the chronological array tail is the last ingested message. The read endpoint still accepts `{lastMessageId}`. Older creation-time/ID history paging remains compatible. Initial migration maps existing messages from their row IDs and maps each old read cursor to its acknowledged message's sequence. The counter survives 30-day body purges and never depends on SQLite reusing or not reusing row IDs.

Service messages are capped at 2,000 characters, eight per participant/thread per minute and sixty per participant across threads per minute. Content uses the existing authenticated encryption key with a distinct thread namespace in authenticated metadata and idempotency fingerprints. Membership/history is checked again after asynchronous encryption and before persistence. Retries reuse the same key and cannot create duplicate messages. Customer replies move the thread to awaiting-restaurant; owner replies move it to awaiting-customer. A new reply reopens a resolved thread.

These service conversations are not a bulk marketing channel. Personalised promotions use the existing consent-checked offer endpoints. Promotion withdrawal does not hide operational conversations or order updates. Persisted recipient-specific notifications contain generic text and `conversationId`, `customerId`, and `restaurantId`; no private message body is copied into the notification. Opening a conversation advances a monotonic read cursor and clears only the corresponding delivered message notifications.

Message bodies expire after 30 days. `runCustomerMessageRetention` removes expired encrypted bodies, their notification badges and stale rate buckets; the parent worker invokes this beside existing order-message retention. Thread and workflow metadata remain available for operational organisation. Database backups/exports must apply the same temporary-message policy as order messages and keep encryption keys separate.

## Notifications and verification

The notification HTTP endpoint now returns at most 100 records per page with an older-message cursor, while the unread count remains the precise full accessible count. Both HTTP and SSE payloads preserve offer destinations and conversation destinations. Current restaurant membership and participant ownership are checked before delivery or marking a notification read. Removed members do not retain access to their former restaurant's notifications.

Focused verification passed: existing offer campaign/checkout regression checks; a synthetic SQLite fixture with 10,001 own-restaurant customers; bounded response and nonoverlapping deterministic pages; escaped search; workflow filtering; tenant and customer isolation; encrypted conversation storage; idempotent replay/conflict; customer replies/read state; unified order/customer inbox; recipient-specific HTTP/SSE notification destinations; membership removal and retention. A separate focused regression verified migration backfill, an earlier-created message ingested after a later-created message was read, correct notification clearing, idempotent sequence reuse and monotonically increasing ingestion after all message rows were purged and SQLite reused row ID 1. The measured 25-customer directory response was approximately 13.3 KB and 150–176 ms on this local Windows fixture. This is a query check, not a production load or concurrent-user benchmark.
