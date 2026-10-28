// Categories follow the owner's menu order; display names never become DOM selectors.
export function menuSections(items = [], query = "") {
  const sections = new Map(), needle = query.trim().toLocaleLowerCase();
  for (const item of items) {
    const title = item.category?.trim() || "Menu";
    if (!sections.has(title)) sections.set(title, { id: `menu-section-${sections.size}`, title, items: [] });
    if (!needle || `${item.name} ${item.description ?? ""} ${title}`.toLocaleLowerCase().includes(needle)) sections.get(title).items.push(item);
  }
  return [...sections.values()].filter(section => section.items.length);
}
