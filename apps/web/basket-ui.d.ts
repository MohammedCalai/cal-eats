export function availableBasketOffers<T extends { restaurantId: string; status: string; expiresAt: string; startsAt?: string | null }>(offers: T[], restaurantId: string, now?: number): T[];
