export const pounds = (minor) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format((Number(minor) || 0) / 100);
export const shortDate = (value) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London" }).format(new Date(value)) : "—";
export const listItems = (value) => Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
export function poundsInputMinor(value, label = "Price") {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label} must be an amount such as 3.50, with at most two decimal places.`);
  const [whole, fraction = ""] = text.split(".");
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor) || minor < 0 || minor > 10_000_000) throw new Error(`${label} must be between £0 and £100,000.`);
  return minor;
}
export const roleHome = (role) => role === "admin" ? "/admin/dashboard" : "/owner/dashboard";
export function businessReturnPath(raw,role) {
  const home=roleHome(role),prefix=role==="admin"?"/admin/":"/owner/";
  if(typeof raw!=="string"||!raw.startsWith("/")||raw.startsWith("//")||/[\\\r\n]/.test(raw))return home;
  try{const target=new URL(raw,"https://cal-eats.invalid");return target.origin==="https://cal-eats.invalid"&&target.pathname.startsWith(prefix)?`${target.pathname}${target.search}`:home;}catch{return home;}
}
export function ownerNavigation(permission = "owner") {
  const core = [
    ["Dashboard", "/owner/dashboard"], ["Orders", "/owner/orders"], ["Menu", "/owner/menu"],
    ["Printers", "/owner/printers"],
  ];
  if (permission === "owner") core.splice(3, 0, ["Inbox", "/owner/inbox"], ["Customers", "/owner/customers"], ["Marketing", "/owner/offers"], ["Refund cases", "/owner/refunds"], ["Support", "/owner/support"]);
  if (permission === "owner") core.push(["Earnings & payouts", "/owner/earnings"], ["Stripe setup", "/owner/stripe"], ["Settings", "/owner/settings"]);
  return core;
}
export const ownerMobileNavigation = permission => permission === "owner" ? [["Home","/owner/dashboard"],["Marketing","/owner/offers"],["Orders","/owner/orders"],["Menu","/owner/menu"]] : [["Home","/owner/dashboard"],["Orders","/owner/orders"],["Menu","/owner/menu"]];
export const adminNavigation = [
  ["Dashboard", "/admin/dashboard"], ["Restaurants", "/admin/restaurants"], ["Orders", "/admin/orders"],
  ["Finance", "/admin/finance"], ["Stripe readiness", "/admin/stripe"], ["Refund cases", "/admin/refunds"], ["Support", "/admin/support"], ["Service areas", "/admin/service-areas"], ["Access & deadlines", "/admin/governance"], ["Operations", "/admin/operations"],
];

export function customerQuery({ q = "", segment, status = "all", page = 1, unread = false } = {}) {
  const query = new URLSearchParams({ page: String(Math.max(1, Math.floor(Number(page) || 1))), pageSize: "25" });
  if (q.trim()) query.set("q", q.trim().slice(0, 100));
  if (segment && segment !== "all") query.set("segment", segment);
  if (status !== "all") query.set("status", status);
  if (unread) query.set("unread", "true");
  return query.toString();
}
export function customerStatusLabel(value) {
  return ({new:"First-time",active:"Active",returning:"Returning",regular:"Regular",lapsed:"Lapsed",vip:"VIP",follow_up:"Follow up",needs_attention:"Needs attention",awaiting_customer:"Waiting for customer",awaiting_restaurant:"Needs reply",open:"Open",resolved:"Resolved",first_order:"First order",percent_off:"Percentage off",fixed_off:"Money off",free_item:"Free item"})[value] || String(value || "Active").replaceAll("_", " ");
}

export function parseMenuCsv(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else if (char === '"') throw new Error("Malformed quote in CSV cell.");
    else cell += char;
  }
  if (quoted) throw new Error("Unclosed quoted CSV cell.");
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  if (!rows.length) throw new Error("CSV is empty.");
  const expected = ["name","description","pricepence","category","allergens","dietarytags"];
  const header = rows.shift().map(v => v.trim().toLowerCase());
  if (header.length !== expected.length || header.some((v,i)=>v!==expected[i])) throw new Error(`Headers must be exactly: ${expected.join(",")}`);
  return rows.filter(r=>r.some(v=>v.trim())).map((r,index)=>{
    if (r.length !== expected.length) throw new Error(`Row ${index+2} must contain exactly six cells.`);
    const [name,description,rawPrice,category,allergens,dietaryTags]=r.map(v=>v.trim());
    const priceMinor=Number(rawPrice);
    if (!name || name.length>120) throw new Error(`Row ${index+2} has an invalid name.`);
    if (!Number.isSafeInteger(priceMinor)||priceMinor<0||priceMinor>1000000) throw new Error(`Row ${index+2} pricepence must be a whole number.`);
    if (description.length>500||category.length>80) throw new Error(`Row ${index+2} contains text that is too long.`);
    return {name,description,priceMinor,category,allergens:splitTags(allergens),dietaryTags:splitTags(dietaryTags),modifierGroups:[]};
  });
}
const splitTags = value => value ? value.split("|").map(v=>v.trim()).filter(Boolean) : [];
