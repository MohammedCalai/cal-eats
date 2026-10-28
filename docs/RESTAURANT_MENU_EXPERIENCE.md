# Customer restaurant menu

The browser preview and native customer app now group dishes by the restaurant's own category names and ordering. Photo dishes use two-column square-image cards; dishes without uploaded photos use compact full-width rows. Both show the actual item price and add controls. Item details contain the full description, restaurant-supplied allergens and available options.

The restaurant name, menu search and category strip stay visible when the introductory restaurant information scrolls away. The current category follows the scroll position; tapping a category jumps to that section. The section picker lists the actual menu categories. Menu search matches the dish name, description and category.

Item details stage quantity and option changes until the customer chooses Add to basket or Update basket. Cancelling discards the staged changes. Required choices and unavailable options are validated, and item quantities are capped at 20. Basket review uses the existing server-quoted checkout and restaurant-set delivery prices.

No review scores, customer counts, restaurant promotions or dish photos are invented. The two requested named restaurant listings still have explicitly labelled sample menus. Business owners can upload their own item photos using the existing menu editor; those photos appear in the new card layout without an app rebuild.

Validation: shared section/search and HTML rendering checks, existing customer basket/modifier tests, native TypeScript, iPhone/Android export, and focused phone-browser checks for pinned navigation, category highlighting, section selection, search, quick add, cancelled choices and option prices. Store-signed device testing remains separate from browser and bundle validation.
