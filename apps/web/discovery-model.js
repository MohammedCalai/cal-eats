export function availableDiscoveryOffer(restaurantId,offers=[],now=Date.now()) {
  return offers.find(offer=>offer.restaurantId===restaurantId&&offer.status==="available"&&Number.isFinite(Date.parse(offer.expiresAt))&&Date.parse(offer.expiresAt)>now&&(!offer.startsAt||Date.parse(offer.startsAt)<=now))||null;
}
const minutes=(restaurant,fulfillment)=>{const value=fulfillment==="delivery"?restaurant.profile?.estimatedDeliveryMinutes:restaurant.profile?.estimatedCollectionMinutes;return Number.isFinite(value)&&value>=0?value:Number.POSITIVE_INFINITY;};
export function discoveryCollections(restaurants,offers=[],fulfillment="delivery",now=Date.now()) {
  const all=[...new Map(restaurants.map(restaurant=>[restaurant.id,restaurant])).values()];
  const quick=[...all].sort((a,b)=>Number(b.acceptingOrders===true)-Number(a.acceptingOrders===true)||minutes(a,fulfillment)-minutes(b,fulfillment));
  const deals=all.filter(restaurant=>availableDiscoveryOffer(restaurant.id,offers,now));
  const lowFee=[...all].sort((a,b)=>(a.delivery?.deliveryFeeMinor??Infinity)-(b.delivery?.deliveryFeeMinor??Infinity));
  return {all,quick,deals,lowFee};
}
export function cuisineIcon(cuisine="") {
  const name=cuisine.toLowerCase();
  const icons={indian:"🍛",italian:"🍕",japanese:"🍣",chinese:"🥡",thai:"🍜",turkish:"🥙",american:"🍔",british:"🐟",caribbean:"🍗",greek:"🥗",lebanese:"🧆",mexican:"🌮",korean:"🍲",vietnamese:"🍜",malaysian:"🍚",nigerian:"🍛",ethiopian:"🥘",persian:"🍢",spanish:"🥘",vegan:"🥑"};
  return Object.prototype.hasOwnProperty.call(icons,name)?icons[name]:"🍽️";
}
