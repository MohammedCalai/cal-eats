import { randomUUID } from "node:crypto";
import { VALIDATION } from "../../../packages/contracts/src/index.js";
import { hashPassword } from "./auth/passwords.js";
import { withTransaction } from "./db/index.js";
import { isDemoEmail } from "./seed.js";

export async function createInitialAdmin(db, { name, email, password, now = new Date(), runMode = "local" }) {
  const normalizedName = typeof name === "string" ? name.trim() : ""; const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (normalizedName.length < VALIDATION.nameMin || normalizedName.length > VALIDATION.nameMax || normalizedEmail.length > VALIDATION.emailMax || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || typeof password !== "string" || password.length < VALIDATION.passwordMin || password.length > VALIDATION.passwordMax) throw new Error("Admin name, email or password is invalid");
  if (runMode === "hosted-preview" && isDemoEmail(normalizedEmail)) throw new Error("Email is reserved in hosted preview");
  if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) throw new Error("An administrator already exists");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(normalizedEmail)) throw new Error("That email already belongs to an account");
  const passwordHash = await hashPassword(password); const id = randomUUID(); const createdAt = now.toISOString();
  return withTransaction(db, () => {
    if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) throw new Error("An administrator already exists");
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(normalizedEmail)) throw new Error("That email already belongs to an account");
    db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)").run(id, normalizedName, normalizedEmail, passwordHash, "admin", createdAt);
    return { id, name: normalizedName, email: normalizedEmail, role: "admin" };
  });
}
