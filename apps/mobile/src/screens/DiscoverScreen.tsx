import { RestaurantMenu } from "./RestaurantMenu";
import { DiscoveryBrowse, type BrowsingFilters } from "./DiscoveryBrowse";
import { useEffect, useRef, useState } from "react";

import { api } from "../api";

import { refreshCart } from "../model";

import type { CartEntry, Fulfillment, MenuItem, Restaurant, Offer } from "../types";

interface Props {
  token: string; onUseOffer?: (restaurantId:string,offerId:string)=>void; fulfillment: Fulfillment; onFulfillment: (value: Fulfillment) => void;
  restaurant: Restaurant | null; cart: CartEntry[]; onRestaurant: (restaurant: Restaurant | null) => void;
  onCart: (entries: CartEntry[]) => void; onCheckout: () => void; focusRestaurantId?: string | null; onRestaurantFocused?: () => void;
}
export function DiscoverScreen(props: Props) {
  const [offers,setOffers]=useState<Offer[]>([]); const [browsingFilters,setBrowsingFilters]=useState<BrowsingFilters>({cuisine:"",offersOnly:false,sort:"recommended",collection:"home"});
  const [postcode, setPostcode] = useState(""); const [query, setQuery] = useState(""); const [restaurants, setRestaurants] = useState<Restaurant[]>([]); const [menu, setMenu] = useState<MenuItem[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false), [menuLoading, setMenuLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const mounted = useRef(false), discoveryRequest = useRef(0), menuRequest = useRef(0), latest = useRef(props), latestCart = useRef(props.cart);
  latest.current = props; latestCart.current = props.cart;
  const loading = discoveryLoading || menuLoading;


  useEffect(() => { mounted.current = true; return () => { mounted.current = false; discoveryRequest.current++; menuRequest.current++; }; }, []);
  function updateCart(entries: CartEntry[]) { latestCart.current = entries; latest.current.onCart(entries); }

  async function loadRestaurants() {
    const request = ++discoveryRequest.current, fulfillment = props.fulfillment, token = props.token;
    const current = () => mounted.current && discoveryRequest.current === request && latest.current.fulfillment === fulfillment && latest.current.token === token;
    setDiscoveryLoading(true); setError("");
    try { const params = new URLSearchParams({ fulfillment }); if (postcode.trim()) params.set("postcode", postcode.trim()); if (query.trim()) params.set("q", query.trim()); const [result,availableOffers] = await Promise.all([api<Restaurant[]>(`/api/restaurants?${params}`, { token }),api<Offer[]>("/api/offers",{token}).catch(()=>[])]); if (current()) {setRestaurants(result);setOffers(availableOffers);} }
    catch (caught) { if (current() && !latest.current.restaurant) setError((caught as Error).message); } finally { if (current()) setDiscoveryLoading(false); }
  }
  useEffect(() => { const timer=setTimeout(()=>void loadRestaurants(),query.trim()?350:0); return()=>clearTimeout(timer); }, [props.fulfillment,query]);

  useEffect(() => { const focused = props.focusRestaurantId; if (focused) void chooseRestaurant({ id: focused }, props.restaurant?.id === focused).then(() => { if (mounted.current && latest.current.focusRestaurantId === focused) latest.current.onRestaurantFocused?.(); }); }, [props.focusRestaurantId]);

  useEffect(() => { if (!props.focusRestaurantId && props.restaurant && !menu.length) void chooseRestaurant(props.restaurant, true); }, [props.restaurant?.id, props.focusRestaurantId]);

  async function chooseRestaurant(restaurant: Pick<Restaurant, "id">, refresh = false) {
    const request = ++menuRequest.current, token = props.token;
    const current = () => mounted.current && menuRequest.current === request && latest.current.token === token && (!latest.current.focusRestaurantId || latest.current.focusRestaurantId === restaurant.id);
    setMenuLoading(true); setError("");
    try {
      const result = await api<{ restaurant: Restaurant; items: MenuItem[] }>(`/api/restaurants/${encodeURIComponent(restaurant.id)}/menu`, { token });
      if (!current()) return;
      latest.current.onRestaurant(result.restaurant); if (latest.current.fulfillment === "delivery" && !result.restaurant.delivery.enabled && result.restaurant.profile.collectionEnabled) latest.current.onFulfillment("collection"); else if (latest.current.fulfillment === "collection" && !result.restaurant.profile.collectionEnabled && result.restaurant.delivery.enabled) latest.current.onFulfillment("delivery"); updateCart(refresh ? refreshCart(latestCart.current, result.items) : []); setMenu(result.items); setNotice(refresh ? "Menu refreshed. Your basket is kept using current prices and available choices." : "");
    }
    catch (caught) { if (current()) setError((caught as Error).message); } finally { if (current()) setMenuLoading(false); }
  }

  function changeQuantity(item: MenuItem, delta: number) {
    const cart = latestCart.current, current = cart.find((entry) => entry.item.id === item.id);
    const next = Math.max(0, Math.min(20, (current?.quantity ?? 0) + delta));
    const selections = current?.selections ?? {};
    updateCart(next ? [...cart.filter((entry) => entry.item.id !== item.id), { item, quantity: next, selections }] : cart.filter((entry) => entry.item.id !== item.id));
  }
  if (props.restaurant) return <RestaurantMenu key={props.restaurant.id} restaurant={props.restaurant} menu={menu} cart={props.cart} fulfillment={props.fulfillment} loading={loading} error={error} notice={notice} onRefresh={() => void chooseRestaurant(props.restaurant!, true)} onBack={() => { menuRequest.current++; setMenuLoading(false); props.onRestaurant(null); updateCart([]); setMenu([]); setError(""); setNotice(""); }} onFulfillment={props.onFulfillment} onQuantity={changeQuantity} onSave={(item, quantity, selections) => updateCart([...latestCart.current.filter(entry => entry.item.id !== item.id), { item, quantity, selections }])} onCheckout={props.onCheckout}/>;

  return <DiscoveryBrowse restaurants={restaurants} offers={offers} fulfillment={props.fulfillment} onFulfillment={props.onFulfillment} postcode={postcode} onPostcode={setPostcode} query={query} onQuery={setQuery} loading={loading} error={error} onRefresh={()=>void loadRestaurants()} filters={browsingFilters} onFilters={patch=>setBrowsingFilters(old=>({...old,...patch}))} onOpen={(restaurant,offerId)=>{if(offerId&&props.onUseOffer)props.onUseOffer(restaurant.id,offerId);else void chooseRestaurant(restaurant);}}/>;
}
