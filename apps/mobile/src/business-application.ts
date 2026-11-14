type BusinessApplicationFields = { name: string; email: string; restaurantName: string; address: string; mobile: string };

// An application supplies contact details only. Initial business access is
// prepared by Cal-Eats after review, independently of customer sign-in fields.
export function businessApplicationPayload(fields: BusinessApplicationFields) {
  return { name: fields.name.trim(), email: fields.email.trim().toLowerCase(), restaurantName: fields.restaurantName.trim(), address: fields.address.trim(), mobile: fields.mobile.trim() };
}
