import { HttpError } from "./http.js";

function pageNumber(url, key, fallback, max) {
  const raw = url.searchParams.get(key) ?? String(fallback), value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new HttpError(400, "VALIDATION_ERROR", "Restaurant pagination is invalid");
  return value;
}

export function discoverRestaurants(db, url, now) {
  const page = pageNumber(url, "page", 1, 100000), pageSize = pageNumber(url, "pageSize", 50, 100);
  const postcode = url.searchParams.get("postcode"), fulfillment = url.searchParams.get("fulfillment");
  const q = url.searchParams.get("q")?.trim().toLowerCase(), cuisine = url.searchParams.get("cuisine")?.trim().toLowerCase();
  if (fulfillment && !["delivery", "collection"].includes(fulfillment)) throw new HttpError(400, "VALIDATION_ERROR", "Fulfillment filter is invalid");
  let outcode = null;
  if (postcode) {
    const match = postcode.trim().toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,2}\d[A-Z\d]?)(?:\d[A-Z]{2})?$/);
    if (!match) throw new HttpError(400, "VALIDATION_ERROR", "Postcode is invalid");
    outcode = match[1];
  }
  if ((q?.length || 0) > 100 || (cuisine?.length || 0) > 80) throw new HttpError(400, "VALIDATION_ERROR", "Search is too long");
  const clauses = ["r.status='approved'", "r.suspended=0"], parameters = [];
  if (fulfillment === "delivery") {
    clauses.push("r.delivery_enabled=1");
    if (outcode) { clauses.push("EXISTS (SELECT 1 FROM json_each(r.delivery_outcodes) WHERE value=?)"); parameters.push(outcode); }
  }
  if (fulfillment === "collection") clauses.push("r.collection_enabled=1");
  if (cuisine) { clauses.push("lower(r.cuisine)=?"); parameters.push(cuisine); }
  if (q) {
    clauses.push("(instr(lower(r.name||' '||r.description||' '||r.cuisine),?)>0 OR EXISTS (SELECT 1 FROM menu_items search WHERE search.restaurant_id=r.id AND search.available=1 AND instr(lower(search.name||' '||search.category),?)>0))");
    parameters.push(q, q);
  }
  // Filter and page in SQL before generating menu search terms, popularity counts or DTOs.
  const selected = db.prepare(`SELECT r.* FROM restaurants r WHERE ${clauses.join(" AND ")} ORDER BY r.name,r.id LIMIT ? OFFSET ?`).all(...parameters, pageSize + 1, (page - 1) * pageSize);
  const since = new Date(now.getTime() - 30 * 86400000).toISOString();
  const counts = db.prepare("SELECT COUNT(*) count FROM orders WHERE restaurant_id=? AND status='completed' AND created_at>=? AND created_at<=?");
  const terms = db.prepare("SELECT COALESCE(group_concat(name||' '||category,' '),'') terms FROM menu_items WHERE restaurant_id=? AND available=1");
  const rows = selected.slice(0, pageSize).map(row => ({ ...row, completed_order_count_30d: counts.get(row.id, since, now.toISOString()).count, search_terms: terms.get(row.id).terms }));
  return { rows, pagination: { page, pageSize, hasNext: selected.length > pageSize, hasPrevious: page > 1 } };
}
