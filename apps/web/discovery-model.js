export function availableDiscoveryOffer(restaurantId,offers=[],now=Date.now(),fulfillment=null) {
  return offers.find(offer=>offer.restaurantId===restaurantId&&!offer.dismissedAt&&!(fulfillment==="collection"&&offer.campaignType==="free_delivery")&&offer.status==="available"&&Number.isFinite(Date.parse(offer.expiresAt))&&Date.parse(offer.expiresAt)>now&&(!offer.startsAt||Date.parse(offer.startsAt)<=now))||null;
}
export function restaurantBrowseFulfillment(restaurant, preferred="delivery") {
  return preferred==="delivery"&&restaurant.delivery?.enabled===false&&restaurant.profile?.collectionEnabled===true?"collection":preferred;
}
export function canPreviewDiscoveryRestaurant(restaurant, preferred="delivery", areaAvailable=null) {
  if(areaAvailable!==false)return true;
  return preferred==="delivery"&&restaurant?.delivery?.enabled===false&&restaurant.profile?.collectionEnabled===true;
}
export function discoveryAvailabilityMessage(restaurant) {
  if(restaurant.profile?.paused)return "Not taking orders right now";
  return restaurant.acceptingOrders===false?restaurant.closedReason||"Not taking orders right now":"";
}
const minutes=(restaurant,fulfillment)=>{const value=restaurantBrowseFulfillment(restaurant,fulfillment)==="delivery"?restaurant.profile?.estimatedDeliveryMinutes:restaurant.profile?.estimatedCollectionMinutes;return Number.isFinite(value)&&value>=0?value:Number.POSITIVE_INFINITY;};
export function discoveryCollections(restaurants,offers=[],fulfillment="delivery",now=Date.now()) {
  const all=[...new Map(restaurants.map(restaurant=>[restaurant.id,restaurant])).values()];
  const quick=all.filter(restaurant=>fulfillment!=="delivery"||restaurant.delivery?.enabled!==false).sort((a,b)=>Number(b.acceptingOrders===true)-Number(a.acceptingOrders===true)||minutes(a,fulfillment)-minutes(b,fulfillment));
  const deals=all.filter(restaurant=>restaurant.availableOfferId||availableDiscoveryOffer(restaurant.id,offers,now,restaurantBrowseFulfillment(restaurant,fulfillment)));
  const lowFee=[...all].sort((a,b)=>(a.delivery?.deliveryFeeMinor??Infinity)-(b.delivery?.deliveryFeeMinor??Infinity));
  const popular=all.filter(restaurant=>Number.isSafeInteger(restaurant.completedOrderCountLast30Days)&&restaurant.completedOrderCountLast30Days>0).sort((a,b)=>b.completedOrderCountLast30Days-a.completedOrderCountLast30Days||String(a.name||a.id).localeCompare(String(b.name||b.id)));
  const freeDelivery=fulfillment==="delivery"?all.filter(restaurant=>restaurant.delivery?.enabled===true&&restaurant.delivery.deliveryFeeMinor===0):[];
  return {all,quick,deals,lowFee,popular,freeDelivery};
}
export function cuisineIcon(cuisine="") {
  const name=cuisine.toLowerCase();
  const icons={indian:"🍛",italian:"🍕",japanese:"🍣",chinese:"🥡",thai:"🍜",turkish:"🥙",american:"🍔",british:"🐟",caribbean:"🍗",greek:"🥗",lebanese:"🧆",mexican:"🌮",korean:"🍲",vietnamese:"🍜",malaysian:"🍚",nigerian:"🍛",ethiopian:"🥘",persian:"🍢",spanish:"🥘",vegan:"🥑"};
  return Object.prototype.hasOwnProperty.call(icons,name)?icons[name]:"🍽️";
}
