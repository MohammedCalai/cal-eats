# Reviewed customer account erasure

This is local implementation, not evidence that the privacy policy, retention schedule, hosting configuration or provider agreements have been approved. The actions and worker remain disabled until `customerPrivacy` contains an explicitly enabled, versioned, dated owner approval with the reviewed retention values. No existing customer is erased by a migration or by submitting a request.

## Request and review

Customers submit `POST /api/account/deletion-requests/verified` (native alias `/api/native/account/deletion-request/verified`) with their current password, `confirm: "DELETE MY ACCOUNT"` and an optional reason. The server reauthenticates, checks the password has not changed during verification, and rejects noncustomer accounts, restaurant memberships and business applications. Passwords are never copied to the request or audit. Current Terms acceptance is not a prerequisite for this privacy route. An open legacy request is upgraded with fresh verification rather than being mistaken for completed deletion.

The response includes the request ID, original received time, verification time, due date and retained categories. `GET /api/account/erasure-requests` lists only the signed-in customer's requests. Login remains available while staff review the request. The operational target is 30 elapsed days, capped by one calendar month where that is sooner. Calendar-month ends are clamped in UTC. A legacy upgrade uses the oldest outstanding request's original received time, not the later password-verification time; repeated requests cannot restart the clock. Requests needing a lawful extension or further verification require staff communication; the code does not silently extend deadlines. The public privacy-policy response exposes `deletionTargetDays: 30` and `deletionTargetCalendarMonths: 1`.

An administrator must first request `GET /api/admin/deletion-requests/:id/erasure-preview`. It returns counts, safe blocker descriptions and an opaque preview hash, never message bodies, passwords, tokens, names or addresses. Completion requires `POST .../:id/erase-customer`, `confirm: "ERASE CUSTOMER DATA"`, the current preview hash and a review note of 20–1000 characters. Review notes must not contain customer contact details. A changed source record invalidates the preview.

The old `close-account` action explicitly closes a login only. It is not erasure evidence. A legacy resolved request or old login-closure audit cannot authorise or prove actual personal-data removal.

## Fail-closed safeguards

Active orders, pending/authorised/uncertain customer payments, unfinished financial operations or workers, unresolved order/help/message incidents, documented legal holds, and claimed or uncertain email/push/printing dispatches block completion. The deliberate `cash_sale_recorded/held` accounting marker means cash sales are excluded from card settlement; it is not an outstanding customer payment and is retained unchanged. Staff must reconcile genuine unknown outcomes rather than assuming delivery or payment failed. Holds use fixed reason codes and a reviewer identity; creating or releasing a hold is an internal reviewed action, not an automated expiry excuse.

Preview validation and all source database changes run in one immediate transaction. Failure rolls everything back, including any deleted messages or addresses. Completion replay returns the original result and does not create a second audit or confirmation. Database guards prevent the erased profile from being reopened, restored order contacts, or stale authenticated requests reinserting customer accounts, messages, addresses, devices or notifications.

## What is removed or minimised

The stable customer ID remains solely as a disabled pseudonymous foreign-key target. Its name becomes `Deleted customer`, email becomes `deleted-<user-id>@account.invalid`, password hash becomes the noncredential sentinel `!deleted`, phone becomes empty, verification timestamp is cleared, and marketing is disabled. Browser/mobile sessions, recovery tokens and recovery mail copies are deleted.

Saved addresses, restaurant customer notes and conversations, order messages, support-message ciphertext, resolved-case attachments and messages, ratings, optional marketing preferences, unused offers/vouchers, notification copies, push registrations and delivery jobs, Live Activity registrations and jobs, and printer receipt copies are removed. Related support rows become content-free stubs. Resolved financial/dispute text is minimised without changing financial amounts or decision states. Order names, email, phone, address, instructions and allergy notes are blanked immediately. Optional modifier/allergen snapshots are removed. Personal free text in offer/voucher/promotion snapshots and related audit details is minimised; financial numbers, necessary IDs, provider bindings and contract policy references remain.

Immutable legal documents and minimal acceptance/order-snapshot evidence are left intact. Minimal allergy-consent evidence is marked withdrawn without retaining note text. Order totals, food/delivery values, discounts, voucher funding, commission, quantities, prices, ledger/journal postings and provider financial references remain necessary transaction evidence. These are pseudonymous, not a claim that the financial record has become fully anonymous. Necessary statutory accounting records are normally retained for six years from the relevant financial-year end, with documented longer exceptions. This financial-record exception does not justify retaining all customer contact information or messages for that period. Disposal at the appropriate financial-year boundary requires the documented accounting process, not an invented automatic purge date.

The matching retention contract uses `chatDays: 30`, `allergyDays: 30`, `orderContactDays: 90`, `resolvedSupportDays: 30` and `accountingYears: 6`. It no longer accepts the superseded twelve-month support policy. Account deletion may remove eligible data sooner than these scheduled operational limits.

## Completion and copies outside the source database

Only a successful transaction creates a completion-confirmation outbox row. Its recipient is encrypted with the existing message key for this single purpose; it is not a replacement login or a public tracking credential. The worker sends a generic confirmation that does not require a deleted login. After provider acceptance, uncertain dispatch or cancellation it clears the encrypted recipient. Unsent recipient material expires within seven days when the worker runs. Unknown dispatches are not automatically resent. Provider acceptance does not prove arrival in the inbox.

The tombstone preserves only the pseudonymous ID, request ID, completion time, policy version, reviewer/note, counts and retained-category explanation. It is immutable suppression evidence. Restore checks must use a separately supplied current tombstone ledger, including erasures newer than a particular backup, before restored data returns to service.

The database transaction does not erase already delivered email, restaurant paper receipts, independently controlled payment/restaurant records or every historical backup. Private local email spool copies follow the separately reviewed spool/backup policy. Those limits and any applicable processor actions must be recorded and explained during review; source minimisation must never be reported as immediate deletion from every external copy.

## Validation

`node --test apps/api/test/customer-erasure.test.js` uses isolated temporary fixture databases only. It covers authentication/roles, verified legacy intake without clock restart, February and 30/31-day month targets, blockers, fresh preview, forced transaction rollback, actual minimisation, unchanged financial digest, unrelated-customer isolation, completion replay, restoration guards, encrypted purpose-limited confirmation and recipient expiry. It performs no hosted writes, provider calls or real customer erasures.
