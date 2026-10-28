export function menuSections<T extends { category?: string; name: string; description?: string }>(items?: T[], query?: string): Array<{ id: string; title: string; items: T[] }>;
