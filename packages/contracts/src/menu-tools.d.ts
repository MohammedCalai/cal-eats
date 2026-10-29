type Item = { name: string; category?: string; available?: boolean; productType?: string };
export function mealDealGroups(items: Item[], makeId: () => string): Array<{ id: string; name: string; minSelections: number; maxSelections: number; options: Array<{ id: string; name: string; priceMinor: number; available: boolean }> }>;
export function menuBatchItems(rows: Array<{name:string;price:string;category:string;description?:string}>): Array<{name:string;priceMinor:number;category:string;description:string;allergens:string[];dietaryTags:string[];modifierGroups:[]}>;
