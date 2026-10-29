import { HttpError } from "./http.js";
export const menuDetailsMigration30 = { version: 30, name: "menu_product_type_and_energy", sql: `
  ALTER TABLE menu_items ADD COLUMN product_type TEXT NOT NULL DEFAULT '';
  ALTER TABLE menu_items ADD COLUMN energy_kcal INTEGER CHECK(energy_kcal IS NULL OR energy_kcal BETWEEN 0 AND 20000);
  ALTER TABLE menu_items ADD COLUMN energy_kj INTEGER CHECK(energy_kj IS NULL OR energy_kj BETWEEN 0 AND 84000);
` };
export function menuDetails(body, current = {}) {
  const type = body.productType === undefined ? current.product_type ?? "" : body.productType;
  if (!["", "meal", "main", "side", "drink", "dessert", "other"].includes(type)) throw new HttpError(400, "VALIDATION_ERROR", "Product type is invalid");
  const energy = (key, old, max) => { const value = body[key] === undefined ? old ?? null : body[key]; if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > max)) throw new HttpError(400, "VALIDATION_ERROR", `${key} must be a whole number or empty`); return value; };
  return { product_type: type, energy_kcal: energy("energyKcal", current.energy_kcal, 20000), energy_kj: energy("energyKj", current.energy_kj, 84000) };
}
