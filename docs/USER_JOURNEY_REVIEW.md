# User journey review — 29 October 2026

The final automated regression run passed **216 tests, zero failures or skips**, across 62 test files. This covers order lifecycles, pricing, required customisations, offers, support routing and threading, permission boundaries, finances, printer queues, service areas and pending-order sound policy. Local review used simulated payments and local email delivery; no customer email or real payment was sent by this walkthrough.

## Browser walkthrough

- Outside-area postcode showed the new message and disabled grey restaurant previews. Available Luton postcode restored browsing. Customer login preserved the chosen postcode; saved/recent address choices were visible.
- Arndale remained collection-only. A meal required starter, rice, vegetable and curry choices. Two configured meals at £8.75 plus a £4.50 side produced three items and a £22 basket/checkout total.
- The customer placed a simulated collection order. Business sound played, continued after minimising the alert and navigating to Menu, and stopped only after confirmation reached the server. The confirmation and 20-minute collection ETA reached the customer. Preparation, ready and collected updates completed the journey.
- Customer-to-restaurant order messaging highlighted the selected restaurant's dashboard shortcut. Business reply appeared in the same customer conversation. A customer profile showed the completed order and permitted a reviewed, individual 10% offer. The customer's Offers page and notification received it.
- Restaurant support reached the platform administrator's Support queue. The administrator replied, and the business saw the original request and administrator reply in the same thread under My requests to Cal-Eats.
- Administrator coverage controls saved a temporary allowlist, correctly excluded LU2, and were restored to automatic restaurant coverage after the check.

## Issues corrected during review

The conversation loading state briefly described a not-yet-loaded conversation as closed; it now says Loading messages and offers retry on a load failure. Route changes now close the tablet drawer and return the page to the top. The menu photo picker now accepts the image formats advertised by its converter. Pending order alerts no longer offer mute/snooze controls; closing their popup does not stop the queue's sound.

## Practical limits

The web platform requires an initial Enable sound interaction and must remain open; browser/OS autoplay and device settings can prevent playback. Native pending-order sound is foreground-only; remote background push delivery is not represented as complete. Physical printer output, real card settlement/payouts, real-device GPS permission handling and store installation require their respective devices/accounts. The iOS signing/developer membership and Google verification tasks remain publication blockers. Passing these checks is evidence of the tested paths, not a guarantee that no defects exist.
