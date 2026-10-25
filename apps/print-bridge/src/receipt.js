import { createHash } from "node:crypto";

const WIDTH = 40;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;

function clean(value, label, max = 300) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function money(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) throw new Error(`${label} must be non-negative integer pence`);
  return `£${(value / 100).toFixed(2)}`;
}

function wrap(value) {
  const result = [];
  let rest = value;
  while (rest.length > WIDTH) {
    let end = rest.lastIndexOf(" ", WIDTH);
    if (end < 1) end = WIDTH;
    result.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

function center(value) {
  return wrap(value).map((line) => `${" ".repeat(Math.max(0, Math.floor((WIDTH - line.length) / 2)))}${line}`);
}

function columns(left, right) {
  if (left.length + right.length + 1 <= WIDTH) return [`${left}${" ".repeat(WIDTH - left.length - right.length)}${right}`];
  return [...wrap(left), ...wrap(right).map((line) => `${" ".repeat(Math.max(0, WIDTH - line.length))}${line}`)];
}

function itemLines(item, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`receipt.items[${index}] is invalid`);
  const name = clean(item.name, `receipt.items[${index}].name`, 120);
  if (!name) throw new Error(`receipt.items[${index}].name is required`);
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new Error(`receipt.items[${index}].quantity is invalid`);
  money(item.unitPriceMinor, `receipt.items[${index}].unitPriceMinor`);
  const total = money(item.totalMinor, `receipt.items[${index}].totalMinor`);
  const lines = columns(`${item.quantity}x ${name}`, total);
  const modifiers = item.modifiers ?? [];
  if (!Array.isArray(modifiers) || modifiers.length > 50) throw new Error(`receipt.items[${index}].modifiers is invalid`);
  for (const [modifierIndex, modifier] of modifiers.entries()) {
    if (!modifier || typeof modifier !== "object") throw new Error(`receipt.items[${index}].modifiers[${modifierIndex}] is invalid`);
    const modifierName = clean(modifier.name, "modifier name", 100);
    if (!modifierName) throw new Error("modifier name is required");
    const suffix = modifier.priceMinor === undefined ? "" : ` ${money(modifier.priceMinor, "modifier priceMinor")}`;
    lines.push(...wrap(`  + ${modifierName}${suffix}`));
  }
  const note = clean(item.note, "item note", 300);
  if (note) lines.push(...wrap(`  Note: ${note}`));
  return lines;
}

export function formatReceipt(receipt, { manualReprint = false } = {}) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("receipt must be a structured object");
  if (receipt.format !== "cal-eats-receipt-v1") throw new Error("receipt.format is unsupported");
  if (receipt.currency !== "GBP") throw new Error("receipt.currency must be GBP");
  const restaurantName = clean(receipt.restaurantName, "receipt.restaurantName", 120);
  const orderNumber = clean(receipt.orderNumber, "receipt.orderNumber", 100);
  if (!restaurantName || !orderNumber) throw new Error("receipt restaurant and order number are required");
  if (!new Set(["delivery", "collection"]).has(receipt.fulfillment)) throw new Error("receipt.fulfillment is invalid");
  const stamp = new Date(receipt.createdAt);
  if (!Number.isFinite(stamp.valueOf())) throw new Error("receipt.createdAt is invalid");
  const items = receipt.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 200) throw new Error("receipt.items is invalid");
  const subtotal = money(receipt.subtotalMinor, "receipt.subtotalMinor");
  const delivery = money(receipt.deliveryFeeMinor, "receipt.deliveryFeeMinor");
  const total = money(receipt.totalMinor, "receipt.totalMinor");
  const lines = ["", "=".repeat(WIDTH), ...center("CAL-EATS"), ...center(restaurantName), "=".repeat(WIDTH)];
  if (manualReprint) lines.push("", ...center("*** MANUAL REPRINT ***"), "");
  lines.push(...columns(`Order: ${orderNumber}`, stamp.toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false })), `Date: ${stamp.toLocaleDateString("en-GB", { timeZone: "Europe/London" })}`, `Fulfilment: ${receipt.fulfillment.toUpperCase()}`);
  const customerName = clean(receipt.customerName, "receipt.customerName", 120);
  const customerPhone = clean(receipt.customerPhone, "receipt.customerPhone", 60);
  const deliveryAddress = clean(receipt.deliveryAddress, "receipt.deliveryAddress", 300);
  if (customerName) lines.push(...wrap(`Customer: ${customerName}`));
  if (customerPhone) lines.push(...wrap(`Phone: ${customerPhone}`));
  if (receipt.fulfillment === "delivery" && deliveryAddress) lines.push(...wrap(`Address: ${deliveryAddress}`));
  const allergyNotes = clean(receipt.allergyNotes, "receipt.allergyNotes", 500);
  const orderNotes = clean(receipt.orderNotes, "receipt.orderNotes", 500);
  if (allergyNotes) lines.push("", "!".repeat(WIDTH), ...wrap(`ALLERGY NOTE: ${allergyNotes}`), "!".repeat(WIDTH));
  if (orderNotes) lines.push("", ...wrap(`ORDER NOTE: ${orderNotes}`));
  lines.push("", "-".repeat(WIDTH), "ITEMS", "");
  for (const [index, item] of items.entries()) lines.push(...itemLines(item, index), "");
  lines.push("-".repeat(WIDTH), ...columns("Food subtotal", subtotal), ...columns("Delivery", delivery), ...columns("TOTAL", total));
  const paymentStatus = clean(receipt.paymentStatus, "receipt.paymentStatus", 80);
  if (!paymentStatus) throw new Error("receipt.paymentStatus is required");
  lines.push(...wrap(`Payment: ${paymentStatus}`), "", ...center("Thank you for ordering with Cal-Eats"), "", "", "");
  const text = lines.join("\n");
  return { text, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

export function escPosBytes(text) {
  const safe = String(text).replace(CONTROL_CHARACTERS, (character) => character === "\n" ? "\n" : " ");
  const bytes = [];
  for (const character of safe) {
    if (character === "£") bytes.push(0x9c);
    else {
      const code = character.codePointAt(0);
      bytes.push(code >= 0x20 && code <= 0x7e || code === 0x0a ? code : 0x3f);
    }
  }
  return Buffer.concat([Buffer.from([0x1b, 0x40, 0x1b, 0x74, 0x00]), Buffer.from(bytes), Buffer.from([0x1d, 0x56, 0x41, 0x03])]);
}
