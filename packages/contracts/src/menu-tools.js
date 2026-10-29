export function mealDealGroups(items, makeId) {
  const definitions = [["Choose your Starter", item => /starter|snack/i.test(item.category || "")], ["Choose your Rice", item => /rice/i.test(item.category || "") || /^(pilau|boiled|steamed|plain|fried) rice$/i.test(item.name)], ["Choose your Vegetable Dish", item => /vegetable/i.test(item.category || "") || /vegetable|chana|saag|bombay/i.test(item.name)], ["Choose your Curry", item => /curry|curries|main/i.test(item.category || "") || /curry|masala|korma/i.test(item.name)]];
  const eligible = items.filter(item => item.available !== false && item.productType !== "meal" && !/meal.?deal|set.?meal/i.test(item.category || ""));
  return definitions.map(([name, matches]) => ({ id: makeId(), name, minSelections: 1, maxSelections: 1, options: eligible.filter(matches).slice(0, 15).map(item => ({ id: makeId(), name: item.name, priceMinor: 0, available: true })) })).map(group => group.options.length ? group : { ...group, options: [{ id: makeId(), name: "", priceMinor: 0, available: true }] });
}
export function menuBatchItems(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 50) throw new Error("Add between 1 and 50 items.");
  return rows.map((row, index) => {
    const name = row.name.trim(), price = row.price.trim();
    if (!name || name.length > 120) throw new Error(`Item ${index + 1} needs a name (up to 120 characters).`);
    if (!/^\d+(?:\.\d{1,2})?$/.test(price)) throw new Error(`Check the price for ${name}. Use pounds and pence.`);
    const [whole, decimals = ""] = price.split("."), priceMinor = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
    if (!Number.isSafeInteger(priceMinor) || priceMinor > 10000000) throw new Error(`The price for ${name} is too large.`);
    if ((row.category || "").length > 80) throw new Error(`The category for ${name} is too long.`);
    return { name, priceMinor, category: row.category.trim() || "Menu", description: (row.description || "").trim().slice(0, 500), allergens: [], dietaryTags: [], modifierGroups: [] };
  });
}
