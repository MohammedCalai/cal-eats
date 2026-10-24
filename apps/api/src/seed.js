import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";

export const DEMO_ACCOUNTS = Object.freeze([
  { name: "Local Admin", email: "admin@calai.local", password: "LocalAdmin!4310", role: "admin" },
  { name: "First Restaurant Owner", email: "restaurant@calai.local", password: "LocalRestaurant!4310", role: "restaurant", restaurant: { name: "Calai Kitchen", status: "approved" } },
  { name: "Second Restaurant Owner", email: "restaurant2@calai.local", password: "LocalRestaurant2!4310", role: "restaurant", restaurant: { name: "Second Spoon", status: "pending" } },
  { name: "Demo Customer", email: "customer@calai.local", password: "LocalCustomer!4310", role: "customer" }
]);

export async function seedDemoData(db, now = new Date()) {
  const timestamp = now.toISOString();
  for (const account of DEMO_ACCOUNTS) {
    let user = db.prepare("SELECT id FROM users WHERE email=?").get(account.email);
    if (!user) {
      const id = randomUUID();
      const passwordHash = await hashPassword(account.password);
      db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(id, account.name, account.email, passwordHash, account.role, timestamp);
      user = { id };
    }
    if (account.restaurant) {
      const membership = db.prepare("SELECT restaurant_id FROM restaurant_memberships WHERE user_id=?").get(user.id);
      if (!membership) withTransaction(db, () => {
        const restaurantId = randomUUID();
        db.prepare("INSERT INTO restaurants(id,name,status,created_at,delivery_enabled,delivery_outcodes,delivery_fee_minor,min_delivery_subtotal_minor) VALUES(?,?,?,?,?,?,?,?)").run(restaurantId, account.restaurant.name, account.restaurant.status, timestamp, 1, JSON.stringify(["N1", "N2"]), 250, 1000);
        db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at) VALUES(?,?,?)").run(restaurantId, user.id, timestamp);
        if (account.restaurant.status === "approved") {
          db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, "Demo bowl", "Local demo menu item", 1200, 1, timestamp, timestamp);
          db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, "Demo side", "Local demo side", 450, 1, timestamp, timestamp);
        }
      });
      else {
        db.prepare("UPDATE restaurants SET delivery_enabled=1,delivery_outcodes=?,delivery_fee_minor=250,min_delivery_subtotal_minor=1000 WHERE id=?").run(JSON.stringify(["N1", "N2"]), membership.restaurant_id);
        const menuCount = db.prepare("SELECT count(*) AS n FROM menu_items WHERE restaurant_id=?").get(membership.restaurant_id).n;
        if (!menuCount && account.restaurant.status === "approved") {
          db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), membership.restaurant_id, "Demo bowl", "Local demo menu item", 1200, 1, timestamp, timestamp);
          db.prepare("INSERT INTO menu_items VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), membership.restaurant_id, "Demo side", "Local demo side", 450, 1, timestamp, timestamp);
        }
      }
    }
  }
  return { accounts: DEMO_ACCOUNTS.length };
}
