# Content safety operations

Internal release/operations record, 8 November 2026. This describes the implementation shipped with this change; confirm the deployed commit before describing the text checks as live. It does not certify store approval or prove that a staffed moderation service exists.

## Server text screening

`apps/api/src/content-moderation.js` screens new order and restaurant/customer conversation messages in both directions, saved quick responses, merchant menu text and modifier labels, menu imports, restaurant profile text, and marketing campaign creation/edits. The restaurant-management routes used by platform administrators reuse these checks.

The local rules target a limited set of clear English personal abuse, threats and sexual requests. They normalize some Unicode lookalikes, zero-width characters, leetspeak and separated letters. They preserve ordinary food names, allergy/health discussion, complaints, negation and clearly attributed past-message evidence in private conversations. Published listings do not receive that quoted-evidence exception.

Rejected new text receives actionable `CONTENT_NOT_ALLOWED` feedback before it is saved, charged a message-rate slot or used to notify recipients. The original draft stays with the client. The rejection does not copy the submitted text into an audit record or automatically create a support case. Existing successful request replays remain idempotent; this change does not rewrite historical content.

These rules can miss context, novel evasion and languages they do not cover, and can produce false positives. They are not an automated image, multilingual or semantic classifier. Human reporting, review and intervention remain necessary.

## Reports and operator responsibility

Customers can report a restaurant/menu, a conversation or an individual merchant message through the existing native report controls. `POST /api/customer-safety/reports` creates a platform support case with no restaurant assignment: the reported merchant cannot read it. The case appears in administrator Support, queues administrator notifications/configured email, and sends the customer a receipt. An explicitly reported message can be retained as encrypted case evidence. Delivery/receipt of an email is separate from queueing it.

Safety reports and support evidence are deliberately not passed through the peer-message filter. Customers must be able to describe or quote what happened. Contact blocking stops restaurant contact and personalised offers while preserving necessary order status updates and Cal-Eats support.

Before public launch, the operator must name a primary reviewer and backup, monitor administrator Support and `support@calai.info`, and ensure timely action. Use **24 hours as an internal initial-review/action target**, with urgent safety issues escalated immediately; do not advertise a guaranteed response time until coverage is actually staffed and verified. Record the case reference, decision, action and follow-up without unnecessary personal-data copies. Follow up with the reporter through the private case.

[Apple guideline 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content) requires filtering, reporting, timely responses, blocking and reachable contact details. Its current published text does not specify a universal 24-hour response deadline; the target above is an operational readiness standard, not a claim about Apple's wording or existing staffing.

## Merchant images: actual manual controls and remaining gap

Uploaded merchant images currently receive file-format/dimension/storage checks, not an objectionable-image classification or mandatory per-image approval. An approved restaurant's changed image can become visible without a queued human approval. Do not claim every photo is reviewed before publication.

On a report, open **Administrator → Restaurants → the restaurant → Menu**, inspect the current image and related case, and remove the menu-item photo or hide the item where necessary. The scoped administrative menu-photo removal route is `DELETE /api/admin/restaurants/:restaurantId/manage/menu/:itemId/photo`; these management changes are audited. An owner can remove their own menu photo or restaurant cover through the existing owner media routes.

The administrative management allowlist does not expose restaurant-cover removal. For an unsafe cover or wider unresolved merchant abuse, the existing administrator restaurant-suspension control can stop public restaurant/media access while the owner removes/replaces it. There is no automatic per-message takedown queue introduced by this patch.

Assign and verify the manual image-review process before public submission. If reliable manual coverage or prevention of unreviewed image publication is required, add and validate that control rather than describing the current report-and-intervene tools as a prepublication approval system.
