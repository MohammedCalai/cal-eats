# Weekly business statements

Each current restaurant owner has a separate weekly email preference. The default is enabled, sent on Monday at 09:00 Europe/London for the preceding Monday–Sunday. Initialization schedules the next occurrence after activation rather than backfilling old weeks. Monday before 09:00 uses that morning; after the scheduled time it uses the following week. Calendar boundaries account for UK daylight-saving changes. The minute worker catches due statements, retaining a distinct owner/restaurant/week key across restarts.

The owner can pause/resume statements on the dashboard. Delivery uses the owner's current account email; the API does not accept arbitrary recipient addresses. Ownership, enabled account/preference, current email and delivery mode are checked again immediately before dispatch. Staff, platform-admin and another restaurant's owner cannot read a restaurant owner's statement through these owner routes. A membership/email change cancels an unsent statement rather than forwarding old financial data or automatically resending it.

## Statement contents and financial meaning

The immutable snapshot includes placed orders, order status events, financial operations, refunds (including refunds for orders from earlier weeks), commission/reversals, direct cash collection, connected-balance movements, and payout record updates. Counts of messages, offers created and refund cases opened are included without customer contact details or message bodies. Amounts in the CSV are integer pence; order/event/financial rows are separate activity views and must not be added together as duplicate sales.

Sales and commission follow confirmed recorded activity, with the existing report fallback for historical accepted orders lacking financial operations. Refunds use their own event dates. Connected-balance transfers/reversals use a single direction of their immutable journal confirmation postings; a transfer started last week but confirmed this week is counted this week. A transfer to Stripe's connected balance is not a bank payout. Paid bank payout totals use the provider's recorded arrival date, not a mutable refresh timestamp; records without an arrival date are listed separately. CSV payout update records are explicitly not additional cashflow. Test or mixed provider histories retain a visible warning even if the current payment configuration later changes.

CSV content is attached when it is at most 1 MiB. Larger snapshots include a same-origin authenticated download link, with no bearer token in the URL. Snapshots exceeding 50,000 activity rows or 10 MiB fail durably with `WEEKLY_STATEMENT_TOO_LARGE`; the worker advances the schedule and does not crash/retry endlessly or send a silently truncated statement. The owner can see the failed status in statement history.

## Delivery boundary

`CALAI_BUSINESS_STATEMENTS_SEND_ENABLED` defaults to false. Statements therefore use the existing private local `.eml` preview adapter, under its `business-statements` subdirectory, even when another mail transport is configured. Enabling external statement sending additionally requires the existing Cal-Eats service-mail transport to be configured. No external email was sent while implementing or testing this feature. The hosted preview's service-mail connection remains a separate deployment step.

The existing fixed sender is reused; no inbox permission, arbitrary attachment file/URL access, new mail credential or new sign-in grant is added. CSV attachments are bounded and allow-listed for the local, SMTP and Microsoft Graph transports. Sending success means provider acceptance, not inbox confirmation. A stable Message-ID and durable lease record prevent routine duplicate dispatch. If a worker loses its lease after dispatch begins, the outcome becomes `unknown` and is not blindly resent.

Local preview emails are not upgraded and resent when external delivery is later enabled. New statements use the newly selected delivery mode; pending rows whose mode no longer matches are canceled.

## Owner API

- `GET /api/restaurant/restaurants/:id/weekly-statements/settings` returns enabled state, current owner email, next scheduled time, fixed UK schedule and delivery readiness.
- `PATCH .../weekly-statements/settings` accepts exactly `{enabled:boolean}`. Re-enabling schedules the next occurrence rather than backfilling paused weeks.
- `GET .../weekly-statements?page=1&pageSize=20` returns only the current owner's paged metadata for that restaurant.
- `GET .../weekly-statements/:statementId.csv` requires the current owner and the snapshot's owner ID; it returns the private CSV download.

Focused checks cover DST weeks, the due boundary, no activation backfill, durable deduplication, old-order refunds, confirmation-week transfers, historical payout refresh exclusion, scoped downloads, recipient changes, ambiguous lease recovery, local MIME attachments, and bounded SMTP/Graph attachment payloads. No live provider, external message, store upload or physical device test is implied.
