import { requireRole } from "./auth/authorization.js";
import { customerOrderIsVisible } from "./customer-order-history.js";
import { withTransaction } from "./db/index.js";
import { exactObject, HttpError, readJson, sendJson } from "./http.js";
import { addNotification } from "./offers.js";

const ratingDto = row => row ? { stars: row.stars, createdAt: row.created_at } : null;

export function restaurantRatingSummary(db, restaurantId) {
  const row = db.prepare("SELECT COUNT(*) rating_count,AVG(stars) rating_average FROM restaurant_order_ratings WHERE restaurant_id=?").get(restaurantId);
  return { ratingCount: row.rating_count, ratingAverage: row.rating_average === null ? null : Math.round(row.rating_average * 10) / 10 };
}

export function orderShopRating(db, order, now) {
  const rating = db.prepare("SELECT stars,created_at FROM restaurant_order_ratings WHERE order_id=?").get(order.id);
  return { shopRating: ratingDto(rating), canRateShop: !rating && order.status === "completed" && customerOrderIsVisible(order, now) };
}

export function queueShopRatingPrompt(db, order, now) {
  if (order.status !== "completed" || !customerOrderIsVisible(order, new Date(now)) || db.prepare("SELECT 1 FROM restaurant_order_ratings WHERE order_id=?").get(order.id)) return;
  if (!db.prepare("SELECT 1 FROM users WHERE id=? AND role='customer' AND account_enabled=1").get(order.customer_id)) return;
  addNotification(db, { userId: order.customer_id, type: "shop_rating", title: `Rate ${order.restaurant_name}`, message: "How was your order? Tap to leave a quick 1–5 star shop rating.", orderId: order.id, restaurantId: order.restaurant_id, eventKey: `order:${order.id}:shop-rating`, now });
}

export async function routeShopRatings({ req, res, url, db, config, session }) {
  const match = url.pathname.match(/^\/api\/orders\/([^/]+)\/shop-rating$/);
  if (req.method !== "POST" || !match) return false;
  const user = requireRole(session, "customer"), body = await readJson(req, config.bodyLimit);
  exactObject(body, ["stars"]);
  if (!Number.isInteger(body.stars) || body.stars < 1 || body.stars > 5) throw new HttpError(400, "VALIDATION_ERROR", "Choose a whole number of stars from 1 to 5");
  const result = withTransaction(db, () => {
    const order = db.prepare("SELECT * FROM orders WHERE id=? AND customer_id=?").get(match[1], user.id), now = config.now();
    if (!order || !customerOrderIsVisible(order, now)) throw new HttpError(404, "NOT_FOUND", "Resource not found");
    if (order.status !== "completed") throw new HttpError(409, "RATING_NOT_ELIGIBLE", "You can rate the shop after your order is completed");
    const prior = db.prepare("SELECT * FROM restaurant_order_ratings WHERE order_id=?").get(order.id);
    if (prior && prior.stars !== body.stars) throw new HttpError(409, "RATING_ALREADY_SUBMITTED", "A shop rating has already been submitted for this order");
    if (!prior) db.prepare("INSERT INTO restaurant_order_ratings(order_id,restaurant_id,customer_id,stars,created_at) VALUES(?,?,?,?,?)").run(order.id, order.restaurant_id, user.id, body.stars, now.toISOString());
    db.prepare("UPDATE user_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND order_id=? AND type='shop_rating'").run(now.toISOString(), user.id, order.id);
    return { replay: Boolean(prior), orderId: order.id, restaurantId: order.restaurant_id, shopRating: ratingDto(prior ?? { stars: body.stars, created_at: now.toISOString() }), ...restaurantRatingSummary(db, order.restaurant_id) };
  });
  return sendJson(res, result.replay ? 200 : 201, { data: result });
}
