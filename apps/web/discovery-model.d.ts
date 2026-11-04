export interface DiscoveryRestaurant {id:string;acceptingOrders?:boolean;availableOfferId?:string|null;completedOrderCountLast30Days?:number;profile?:{cuisine?:string;estimatedDeliveryMinutes?:number;estimatedCollectionMinutes?:number};delivery?:{enabled?:boolean;deliveryFeeMinor?:number};}
export interface DiscoveryOffer {id:string;restaurantId:string;status:string;expiresAt:string;startsAt?:string|null;dismissedAt?:string|null;campaignType?:string|null;}
export function availableDiscoveryOffer<T extends DiscoveryOffer>(restaurantId:string,offers?:T[],now?:number,fulfillment?:"delivery"|"collection"|null):T|null;
export function discoveryCollections<T extends DiscoveryRestaurant>(restaurants:T[],offers?:DiscoveryOffer[],fulfillment?:"delivery"|"collection",now?:number):{all:T[];quick:T[];deals:T[];lowFee:T[];popular:T[];freeDelivery:T[]};
export function cuisineIcon(cuisine?:string):string;
