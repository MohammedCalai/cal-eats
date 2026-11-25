import { HttpError } from "./http.js";

export function customerSearch(url) {
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length > 160) throw new HttpError(400, "VALIDATION_ERROR", "Customer search is invalid");

  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const filter = "u.role='customer' AND (?='' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\')";
  return { query, filter, args: [query, pattern, pattern, pattern] };
}
