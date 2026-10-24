import { VALIDATION } from "../../../packages/contracts/src/index.js";
import { HttpError, exactObject } from "./http.js";

const text = (value, min, max, label) => { const result = typeof value === "string" ? value.trim() : ""; if (result.length < min || result.length > max) throw new HttpError(400, "VALIDATION_ERROR", `${label} is invalid`); return result; };
export function normalizeAddress(value, { withLabel = false } = {}) {
  exactObject(value, withLabel ? ["label", "line1", "line2", "city", "postcode"] : ["line1", "line2", "city", "postcode"]);
  const compact = typeof value.postcode === "string" ? value.postcode.trim().toUpperCase().replace(/\s+/g, "") : ""; const match = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  if (!match) throw new HttpError(400, "VALIDATION_ERROR", "Delivery postcode is invalid");
  return { ...(withLabel ? { label: text(value.label, 1, 40, "Address label") } : {}), line1: text(value.line1, 1, VALIDATION.addressLineMax, "Address line 1"), ...(value.line2 === undefined || value.line2 === "" ? {} : { line2: text(value.line2, 1, VALIDATION.addressLineMax, "Address line 2") }), city: text(value.city, 1, VALIDATION.cityMax, "City"), postcode: `${match[1]} ${match[2]}`, outcode: match[1] };
}
