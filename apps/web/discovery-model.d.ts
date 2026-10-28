export interface DiscoveryRestaurant {id:string;acceptingOrders?:boolean;profile?:{cuisine?:string;estimatedDeliveryMinutes?:number;estimatedCollectionMinutes?:number};delivery?:{deliveryFeeMinor?:number};}
export interface DiscoveryOffer {id:string;restaurantId:string;status:string;expiresAt:string;startsAt?:string|null;}
export function availableDiscoveryOffer<T extends DiscoveryOffer>(restaurantId:string,offers?:T[],now?:number):T|null;
export function discoveryCollections<T extends DiscoveryRestaurant>(restaurants:T[],offers?:DiscoveryOffer[],fulfillment?:"delivery"|"collection",now?:number):{all:T[];quick:T[];deals:T[];lowFee:T[]};
export function cuisineIcon(cuisine?:string):string;
