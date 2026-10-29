# Basket and close-control update

The customer browser and native apps have a separate basket review before checkout. It shows current item photos (or an honest placeholder), chosen options, quantity controls, line prices, restaurant-set delivery fees, applicable restaurant offers, Add items and a fixed checkout action. Closing the basket returns to its menu without losing the items. The last quantity can be removed; checkout is disabled for an empty basket.

Basket prices are estimates before the existing checkout quote. Offers are filtered by restaurant, availability and dates. No discount value or savings is claimed before the server validates it. The existing price-change, retry, payment and order-confirmation controls are unchanged.

All browser dialogs now have a 44-pixel X in a fixed header outside the scroll area. This covers notifications, item options, category selection, order chat, restaurant conversations, support requests and refund cases. Escape, outside-click dismissal and the existing bottom Close action remain. The business notification panel also has an explicit, sticky close control. Native category selection and customer conversation screens have persistent close controls.

Focused validation includes basket option/quantity/fee calculations, expired or unrelated offer exclusion, native TypeScript and iPhone/Android bundle compilation. Phone browser checks cover long notifications (100 entries), the X after scrolling, basket quantity changes, item editing and continuing to server-quoted checkout. No paid order is placed by these checks.
