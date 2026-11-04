import { HttpError } from "./http.js";

function pageNumber(url, key, fallback, max) {
  const raw = url.searchParams.get(key) ?? String(fallback), value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new HttpError(400, "VALIDATION_ERROR", "Restaurant pagination is invalid");
  return value;
}

export function discoverRestaurants(db, url, now, customerId = null) {
  const page = pageNumber(url, "page", 1, 100000), pageSize = pageNumber(url, "pageSize", 50, 100);
  const postcode = url.searchParams.get("postcode"), fulfillment = url.searchParams.get("fulfillment");
  const q = url.searchParams.get("q")?.trim().toLowerCase(), cuisine = url.searchParams.get("cuisine")?.trim().toLowerCase();
  const collection = url.searchParams.get("collection") || "all", sort = url.searchParams.get("sort") || "recommended";
  if (fulfillment && !["delivery", "collection"].includes(fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Fulfillment filter is invalid");
  if (!["all", "offers", "popular", "free-delivery", "quick"].includes(collection) || !["recommended", "quick", "fee"].includes(sort)) throw new HttpError(400, "VALIDATION_ERROR", "Restaurant collection is invalid");
  let outcode = null;
  if (postcode) {
    const match = postcode.trim().toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/);
    if (!match) throw new HttpError(400, "VALIDATION_ERROR", "Postcode is invalid");
    outcode = match[1];
  }
  if ((q?.length || 0) > 100 || (cuisine?.length || 0) > 80) throw new HttpError(400, "VALIDATION_ERROR", "Search is too long");
  const clauses = ["r.status='approved'", "r.suspended=0"], parameters = { now: now.toISOString(), since: new Date(now.getTime() - 30 * 86400000).toISOString(), limit: pageSize + 1, offset: (page - 1) * pageSize };
  if (fulfillment === "delivery") {
    clauses.push("r.delivery_enabled=1");
    if (outcode) { clauses.push("EXISTS (SELECT 1 FROM json_each(r.delivery_outcodes) WHERE value=$outcode)"); parameters.outcode = outcode; }
  }
  if (fulfillment === "collection") clauses.push("r.collection_enabled=1");
  if (cuisine) { clauses.push("lower(r.cuisine)=$cuisine"); parameters.cuisine = cuisine; }
  if (q) {
    clauses.push("(instr(lower(r.name||' '||r.description||' '||r.cuisine),$q)>0 OR EXISTS (SELECT 1 FROM menu_items search WHERE search.restaurant_id=r.id AND search.available=1 AND instr(lower(search.name||' '||search.category),$q)>0))");
    parameters.q = q;
  }
  const popularity = "(SELECT COUNT(*) FROM orders o WHERE o.restaurant_id=r.id AND o.status='completed' AND o.created_at>=$since AND o.created_at<=$now)";
  const permitted = customerId && db.prepare("SELECT COALESCE(mp.in_app_promotions,u.merchant_offers,0) allowed FROM users u LEFT JOIN marketing_preferences mp ON mp.user_id=u.id WHERE u.id=?").get(customerId)?.allowed;
  let availableOffer = "NULL";
  if (permitted) {
    parameters.customer = customerId;
    availableOffer = `(SELECT g.id FROM offer_grants g JOIN offer_campaigns c ON c.id=g.campaign_id WHERE g.restaurant_id=r.id AND g.customer_id=$customer AND g.dismissed_at IS NULL AND g.status='available' AND c.expires_at>$now AND COALESCE(c.starts_at,c.created_at)<=$now${fulfillment === "collection" ? " AND COALESCE(c.campaign_type,'')<>'free_delivery'" : ""} AND (COALESCE(json_extract(c.campaign_rules,'$.audienceSegment'),c.recipient_segment,'')<>'first_order' OR NOT EXISTS(SELECT 1 FROM orders prior WHERE prior.restaurant_id=r.id AND prior.customer_id=$customer AND prior.status='completed')) ORDER BY c.expires_at,g.id LIMIT 1)`;
  }
  if (collection === "offers") clauses.push(`${availableOffer} IS NOT NULL`);
  if (collection === "popular") clauses.push(`${popularity}>0`);
  if (collection === "free-delivery") clauses.push(fulfillment === "collection" ? "0" : "r.delivery_enabled=1 AND r.delivery_fee_minor=0");
  const minutes = fulfillment === "collection" ? "r.estimated_collection_minutes" : "r.estimated_delivery_minutes";
  const order = collection === "popular" ? "completed_order_count_30d DESC," : collection === "quick" || sort === "quick" ? `${minutes} IS NULL,${minutes},` : sort === "fee" ? "r.delivery_fee_minor," : "";
  // Category filtering happens before pagination, so See all includes the whole directory.
  const selected = db.prepare(`SELECT r.*,${popularity} completed_order_count_30d,${availableOffer} available_offer_id,(SELECT COUNT(*) FROM restaurant_order_ratings rating WHERE rating.restaurant_id=r.id) rating_count,(SELECT AVG(stars) FROM restaurant_order_ratings rating WHERE rating.restaurant_id=r.id) rating_average FROM restaurants r WHERE ${clauses.join(" AND ")} ORDER BY ${order}r.name,r.id LIMIT $limit OFFSET $offset`).all(parameters);
  const terms = db.prepare("SELECT COALESCE(group_concat(name||' '||category,' '),'') terms FROM menu_items WHERE restaurant_id=? AND available=1");
  const rows = selected.slice(0, pageSize).map(row => ({ ...row, search_terms: terms.get(row.id).terms }));
  return { rows, pagination: { page, pageSize, hasNext: selected.length > pageSize, hasPrevious: page > 1 } };
}
