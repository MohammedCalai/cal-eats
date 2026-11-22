import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";

export const DEMO_ACCOUNTS = Object.freeze([
  { name: "Local Admin", email: "admin@calai.local", password: "LocalAdmin!4310", role: "admin" },
  { name: "First Restaurant Owner", email: "restaurant@calai.local", password: "LocalRestaurant!4310", role: "restaurant", restaurant: { name: "Calai Kitchen", status: "approved" } },
  { name: "Second Restaurant Owner", email: "restaurant2@calai.local", password: "LocalRestaurant2!4310", role: "restaurant", restaurant: { name: "Second Spoon", status: "pending" } },
  { name: "Demo Customer", email: "customer@calai.local", password: "LocalCustomer!4310", role: "customer" }
]);
const demoEmails = new Set(DEMO_ACCOUNTS.map((account) => account.email));
export const isDemoEmail = (email) => demoEmails.has(String(email).trim().toLowerCase());
export function assertHostedPreviewSafe(db, config) {
  if (config.runMode !== "hosted-preview") return;
  const placeholders = DEMO_ACCOUNTS.map(() => "?").join(",");
  if (db.prepare(`SELECT 1 FROM users WHERE email IN (${placeholders}) LIMIT 1`).get(...DEMO_ACCOUNTS.map((account) => account.email))) throw new Error("Hosted preview refuses a database containing reserved demo accounts");
}

export async function seedDemoData(db, now = new Date(), { runMode = "local", businessProducts = true } = {}) {
  if (runMode !== "local") throw new Error("Demo seed is available only in local mode");
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
        db.prepare("INSERT INTO restaurants(id,name,status,created_at,delivery_enabled,delivery_outcodes,delivery_fee_minor,min_delivery_subtotal_minor) VALUES(?,?,?,?,?,?,?,?)").run(restaurantId, account.restaurant.name, account.restaurant.status, timestamp, 1, JSON.stringify(["LU1", "LU2"]), 250, 1000);
        db.prepare("UPDATE restaurants SET description=?,cuisine=?,address=?,phone=?,always_open=1 WHERE id=?").run("Fictional local demo restaurant", "Demo food", "Fictional address, Luton", "01632 960001", restaurantId);
        db.prepare("INSERT INTO restaurant_memberships(restaurant_id,user_id,created_at) VALUES(?,?,?)").run(restaurantId, user.id, timestamp);
        db.prepare("INSERT INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, 700, 24, "demo-v1", 1, timestamp, user.id, timestamp);
        if (account.restaurant.status === "approved") {
          db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, "Grilled chicken bowl", "Grilled chicken with seasoned rice, fresh salad and your choice of sauce.", 1200, 1, timestamp, timestamp, "Mains", "[]", "[]", JSON.stringify([{ id: "sauce", name: "Sauce", minSelections: 0, maxSelections: 1, options: [{ id: "lemon-herb", name: "Lemon herb", priceMinor: 0, available: true }, { id: "chilli-mayo", name: "Chilli mayo", priceMinor: 50, available: true }] }]));
          db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), restaurantId, "Seasoned fries", "Crisp fries tossed in a savoury seasoning.", 450, 1, timestamp, timestamp, "Sides", "[]", "[]", "[]");
        }
      });
      else {
        const existing = db.prepare("SELECT * FROM restaurants WHERE id=?").get(membership.restaurant_id);
        if (!existing.phone?.trim()) db.prepare("UPDATE restaurants SET phone=? WHERE id=?").run("01632 960001", existing.id);
        if (existing.delivery_outcodes === JSON.stringify(["N1", "N2"]) && existing.delivery_fee_minor === 250 && existing.min_delivery_subtotal_minor === 1000) {
          db.prepare("UPDATE restaurants SET delivery_outcodes=? WHERE id=?").run(JSON.stringify(["LU1", "LU2"]), membership.restaurant_id);
        }
        if (!existing.description && !existing.cuisine && !existing.address && existing.opening_hours === "[]" && !existing.always_open) db.prepare("UPDATE restaurants SET description=?,cuisine=?,address=?,always_open=1 WHERE id=?").run("Fictional local demo restaurant", "Demo food", "Fictional address, Luton", membership.restaurant_id);
        db.prepare("INSERT OR IGNORE INTO contracts VALUES(?,?,?,?,?,?,?,?,?)").run(randomUUID(), membership.restaurant_id, 700, 24, "demo-v1", 1, timestamp, user.id, timestamp);
        const menuCount = db.prepare("SELECT count(*) AS n FROM menu_items WHERE restaurant_id=?").get(membership.restaurant_id).n;
        if (!menuCount && account.restaurant.status === "approved") {
          db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), membership.restaurant_id, "Grilled chicken bowl", "Grilled chicken with seasoned rice, fresh salad and your choice of sauce.", 1200, 1, timestamp, timestamp, "Mains", "[]", "[]", JSON.stringify([{ id: "sauce", name: "Sauce", minSelections: 0, maxSelections: 1, options: [{ id: "lemon-herb", name: "Lemon herb", priceMinor: 0, available: true }, { id: "chilli-mayo", name: "Chilli mayo", priceMinor: 50, available: true }] }]));
          db.prepare("INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category,allergens,dietary_tags,modifier_groups) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), membership.restaurant_id, "Seasoned fries", "Crisp fries tossed in a savoury seasoning.", 450, 1, timestamp, timestamp, "Sides", "[]", "[]", "[]");
        }
        for (const demo of db.prepare("SELECT * FROM menu_items WHERE restaurant_id=?").all(membership.restaurant_id)) {
          const legacyBowl = demo.name === "Demo bowl" && demo.price_minor === 1200 && demo.available === 1 && ["Local demo menu item", "Fictional local demo menu item"].includes(demo.description) && ["", "Mains"].includes(demo.category) && ["[]", JSON.stringify(["sesame"])].includes(demo.allergens) && ["[]", JSON.stringify(["demo"])].includes(demo.dietary_tags) && demo.modifier_groups === "[]";
          const legacySide = demo.name === "Demo side" && demo.price_minor === 450 && demo.available === 1 && ["Local demo side", "Fictional local demo side"].includes(demo.description) && ["", "Sides"].includes(demo.category) && demo.allergens === "[]" && ["[]", JSON.stringify(["demo"])].includes(demo.dietary_tags) && demo.modifier_groups === "[]";
          if (legacyBowl) db.prepare("UPDATE menu_items SET name=?,description=?,category='Mains',allergens='[]',dietary_tags='[]',modifier_groups=?,updated_at=? WHERE id=?").run("Grilled chicken bowl", "Grilled chicken with seasoned rice, fresh salad and your choice of sauce.", JSON.stringify([{ id: "sauce", name: "Sauce", minSelections: 0, maxSelections: 1, options: [{ id: "lemon-herb", name: "Lemon herb", priceMinor: 0, available: true }, { id: "chilli-mayo", name: "Chilli mayo", priceMinor: 50, available: true }] }]), timestamp, demo.id);
          if (legacySide) db.prepare("UPDATE menu_items SET name=?,description=?,category='Sides',allergens='[]',dietary_tags='[]',modifier_groups='[]',updated_at=? WHERE id=?").run("Seasoned fries", "Crisp fries tossed in a savoury seasoning.", timestamp, demo.id);
        }
      }
    }
  }
  for (const integration of [
    ["mock_payments", "mock", 1, "Deterministic local adapter; no provider call"],
    ["stripe", "off", 0, "Live payments disabled"],
    ["apple_pay", "off", 0, "Provider integration not configured"],
    ["notifications", "mock", 1, "Local outbox sink only"],
    ["printing", "mock", 1, "Browser handoff records only"]
  ]) db.prepare("INSERT OR IGNORE INTO integration_status VALUES(?,?,?,?,?,?)").run(randomUUID(), ...integration, timestamp);
  // Local fixtures explicitly authorise their synthetic merchants; this never runs in hosted mode.
  // Restrict this to the two reserved demo owners. Running a local seed must
  // never enable an unrelated merchant or overwrite an existing admin choice.
  if(businessProducts&&db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='business_product_permissions'").get()){
    for(const restaurant of db.prepare("SELECT DISTINCT r.id,r.name,r.created_at FROM restaurants r JOIN restaurant_memberships m ON m.restaurant_id=r.id JOIN users u ON u.id=m.user_id WHERE u.email IN ('restaurant@calai.local','restaurant2@calai.local')").all()){
      const businessId=db.prepare("SELECT business_id FROM business_product_links WHERE product='cal-eats' AND restaurant_id=?").get(restaurant.id)?.business_id??restaurant.id;
      db.prepare('INSERT OR IGNORE INTO business_accounts(id,name,created_at,updated_at) VALUES(?,?,?,?)').run(businessId,restaurant.name,timestamp,timestamp);
      db.prepare("INSERT OR IGNORE INTO business_product_links(id,business_id,product,source_account_id,restaurant_id,status,created_at,updated_at) VALUES(?,?,'cal-eats',?,?,'active',?,?)").run(restaurant.id,businessId,restaurant.id,restaurant.id,timestamp,timestamp);
      db.prepare("INSERT OR IGNORE INTO business_account_memberships(business_id,user_id,permission,created_at,membership_source) SELECT ?,user_id,permission,created_at,'cal-eats' FROM restaurant_memberships WHERE restaurant_id=?").run(businessId,restaurant.id);
      for(const product of ['calai','cal-eats'])db.prepare('INSERT OR IGNORE INTO business_product_permissions(business_id,product,allowed,changed_at) VALUES(?,?,?,?)').run(businessId,product,product==='cal-eats'?1:0,timestamp);
    }
  }
  return { accounts: DEMO_ACCOUNTS.length };
}
