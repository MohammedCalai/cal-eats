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
        db.prepare("INSERT INTO restaurants(id,name,status,created_at) VALUES(?,?,?,?)").run(restaurantId, account.restaurant.name, account.restaurant.status, timestamp);
        db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at) VALUES(?,?,?)").run(restaurantId, user.id, timestamp);
      });
    }
  }
  return { accounts: DEMO_ACCOUNTS.length };
}
