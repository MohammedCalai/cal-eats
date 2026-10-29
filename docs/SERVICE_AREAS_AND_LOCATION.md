# Customer location and platform coverage

Platform administrators manage **Service areas** in the business platform. The default follows approved restaurants' configured delivery and collection coverage. An optional platform postcode-area allowlist narrows that coverage; it cannot extend a restaurant's coverage. Restaurant owners continue to control delivery fees.

Customers outside coverage see **“We’re not delivering to your area yet”** and **“We’re expanding—check back soon for restaurants near you.”** Restaurant previews are greyed and cannot be opened for ordering. There is no alternative-address prompt in that panel. Administrators can edit both sentences.

Saved addresses and the customer's five distinct recent delivery addresses appear in the location picker. Address selection can prefill checkout. Private address choices are cleared when identity changes. Only the postcode is remembered for the signed-in customer's discovery preference; GPS coordinates are not stored.

“Use my location” requests foreground permission only after the customer taps it. With consent, coordinates are sent through the API to Postcodes.io to resolve an approximate postcode. The app discloses the provider before the tap. Customers must complete/check their street address at checkout. Denial, timeout and unsupported location services leave manual postcode entry available. No background location permission is requested.

Provider documentation: [reverse geocoding](https://postcodes.io/docs/postcode/reverse-geocode/). Physical-device permission and GPS behaviour still require device testing.

## API and migration

Migration 31 adds platform coverage settings. Public availability checks validate UK postcodes/outcodes. Only administrators can read/change platform settings. Recent-address reads are scoped to the authenticated customer. The coordinate resolver validates consent and coordinates, limits requests, uses a fixed provider endpoint and has a five-second provider timeout.

Custom restrictions are enforced on both quote and order placement, after an existing idempotent order replay is resolved. Collection checks the restaurant's location, rather than the customer's home postcode. Automatic coverage ignores a restaurant's temporary closure when deciding whether the platform serves a region; normal restaurant opening/ordering checks still apply.
