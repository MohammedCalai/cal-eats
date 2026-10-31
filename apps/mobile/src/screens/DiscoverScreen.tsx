import { RestaurantMenu } from "./RestaurantMenu";
import { DiscoveryBrowse, type BrowsingFilters } from "./DiscoveryBrowse";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import type {ServiceArea} from "../LocationPicker";

import { api } from "../api";

import { refreshCart } from "../model";

import type { Address, CartEntry, Fulfillment, MenuItem, Restaurant, Offer } from "../types";

interface Props {
  userId:string;address:Address|null;onAddress:(address:Address)=>void;
  token: string; onUseOffer?: (restaurantId:string,offerId:string)=>void; fulfillment: Fulfillment; onFulfillment: (value: Fulfillment) => void;
  restaurant: Restaurant | null; cart: CartEntry[]; onRestaurant: (restaurant: Restaurant | null) => void;
  onCart: (entries: CartEntry[]) => void; onCheckout: () => void; focusRestaurantId?: string | null; onRestaurantFocused?: () => void;
}
export function DiscoverScreen(props: Props) {
  const [browsing,setBrowsing]=useState(!props.restaurant);
  const [offers,setOffers]=useState<Offer[]>([]); const [browsingFilters,setBrowsingFilters]=useState<BrowsingFilters>({cuisine:"",offersOnly:false,sort:"recommended",collection:"home"});
  const [postcode, setPostcode] = useState(props.address?.postcode||""); const [query, setQuery] = useState(""); const [restaurants, setRestaurants] = useState<Restaurant[]>([]); const [menu, setMenu] = useState<MenuItem[]>([]);const [serviceArea,setServiceArea]=useState<ServiceArea|null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false), [menuLoading, setMenuLoading] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [hasMoreRestaurants, setHasMoreRestaurants] = useState(false), [loadingMoreRestaurants, setLoadingMoreRestaurants] = useState(false);
  const discoveryScope = JSON.stringify([props.userId, props.token, props.fulfillment, postcode.trim(), query.trim(), browsingFilters.cuisine]);
  const latestDiscoveryScope = useRef(discoveryScope); latestDiscoveryScope.current = discoveryScope;
  const discoveryPagination = useRef({ scope: "", page: 0, hasMore: false, loading: false });
  const mounted = useRef(false), discoveryRequest = useRef(0), menuRequest = useRef(0), latest = useRef(props), latestCart = useRef(props.cart);
  latest.current = props; latestCart.current = props.cart;
  const loading = discoveryLoading || menuLoading;


  useEffect(() => { mounted.current = true; return () => { mounted.current = false; discoveryRequest.current++; menuRequest.current++; }; }, []);
  useEffect(()=>{let active=true;if(!props.address)void SecureStore.getItemAsync(`cal-eats-postcode-${props.userId}`).then(value=>{if(active&&value)setPostcode(value);}).catch(()=>{});return()=>{active=false;};},[props.userId]);
  useEffect(() => { if (props.address) setPostcode(props.address.postcode); }, [props.address?.postcode]);
  function selectLocation(address:Address){setPostcode(address.postcode);props.onAddress(address);void SecureStore.setItemAsync(`cal-eats-postcode-${props.userId}`,address.postcode).catch(()=>{});}
  function updateCart(entries: CartEntry[]) { latestCart.current = entries; latest.current.onCart(entries); }

  async function loadRestaurants(append = false) {
    const scope = discoveryScope, pagination = discoveryPagination.current;
    if (append && (pagination.scope !== scope || pagination.loading || !pagination.hasMore)) return;
    const request = ++discoveryRequest.current, fulfillment = props.fulfillment, token = props.token, page = append ? pagination.page + 1 : 1;
    const current = () => mounted.current && discoveryRequest.current === request && latestDiscoveryScope.current === scope;
    discoveryPagination.current = { scope, page: append ? pagination.page : 0, hasMore: append && pagination.hasMore, loading: true };
    if (append) setLoadingMoreRestaurants(true); else { setDiscoveryLoading(true); setLoadingMoreRestaurants(false); setHasMoreRestaurants(false); }
    setError("");
    try {
      const area = append && serviceArea ? serviceArea : await api<ServiceArea>(`/api/service-availability?postcode=${encodeURIComponent(postcode)}&fulfillment=${fulfillment}`, { token });
      if (!current()) return;
      setServiceArea(area);
      const params = new URLSearchParams({ fulfillment, page: String(page), pageSize: "50" });
      if (postcode.trim() && area.available !== false) params.set("postcode", postcode.trim());
      if (query.trim()) params.set("q", query.trim());
      if (browsingFilters.cuisine) params.set("cuisine", browsingFilters.cuisine);
      const [result, availableOffers] = await Promise.all([api<Restaurant[]>(`/api/restaurants?${params}`, { token }), append ? Promise.resolve(offers) : api<Offer[]>("/api/offers", { token }).catch(() => [])]);
      if (!current()) return;
      setRestaurants(previous => append ? [...new Map([...previous, ...result].map(restaurant => [restaurant.id, restaurant])).values()] : result);
      setOffers(availableOffers);
      const hasMore = result.length === 50;
      discoveryPagination.current = { scope, page, hasMore, loading: false };
      setHasMoreRestaurants(hasMore);
    } catch (caught) { if (current()) setError((caught as Error).message); }
    finally { if (current()) { discoveryPagination.current.loading = false; setDiscoveryLoading(false); setLoadingMoreRestaurants(false); } }
  }
  useEffect(() => {
    discoveryRequest.current++;
    discoveryPagination.current = { scope: discoveryScope, page: 0, hasMore: false, loading: false };
    setRestaurants([]); setServiceArea(null); setHasMoreRestaurants(false); setLoadingMoreRestaurants(false); setDiscoveryLoading(true); setError("");
    const timer = setTimeout(() => void loadRestaurants(), query.trim() ? 350 : 0);
    return () => { clearTimeout(timer); discoveryRequest.current++; };
  }, [discoveryScope]);

  useEffect(() => { const focused = props.focusRestaurantId; if (focused) void chooseRestaurant({ id: focused }, props.restaurant?.id === focused).then(() => { if (mounted.current && latest.current.focusRestaurantId === focused) latest.current.onRestaurantFocused?.(); }); }, [props.focusRestaurantId]);

  useEffect(() => { if (!browsing && !props.focusRestaurantId && props.restaurant && !menu.length) void chooseRestaurant(props.restaurant, true); }, [props.restaurant?.id, props.focusRestaurantId]);

  async function chooseRestaurant(restaurant: Pick<Restaurant, "id">, refresh = false, replacementConfirmed = false) {
    if(!refresh && !replacementConfirmed && latestCart.current.length && latest.current.restaurant?.id !== restaurant.id){const itemCount=latestCart.current.reduce((sum,entry)=>sum+entry.quantity,0), nextRestaurant=restaurants.find(candidate=>candidate.id===restaurant.id)?.name||"this restaurant";Alert.alert("Start a new basket?",`Your basket from ${latest.current.restaurant?.name||"another restaurant"} has ${itemCount} ${itemCount===1?"item":"items"}. Starting a new basket with ${nextRestaurant} will remove those items.`,[{text:"Keep my basket",style:"cancel"},{text:"Clear & start new",style:"destructive",onPress:()=>void chooseRestaurant(restaurant,false,true)}]);return;}
    if(latest.current.restaurant?.id===restaurant.id && latestCart.current.length)refresh=true;
    const request = ++menuRequest.current, token = props.token;
    const current = () => mounted.current && menuRequest.current === request && latest.current.token === token && (!latest.current.focusRestaurantId || latest.current.focusRestaurantId === restaurant.id);
    setMenuLoading(true); setError("");
    try {
      const result = await api<{ restaurant: Restaurant; items: MenuItem[] }>(`/api/restaurants/${encodeURIComponent(restaurant.id)}/menu`, { token });
      if (!current()) return;
      setBrowsing(false); latest.current.onRestaurant(result.restaurant); if (latest.current.fulfillment === "delivery" && !result.restaurant.delivery.enabled && result.restaurant.profile.collectionEnabled) latest.current.onFulfillment("collection"); else if (latest.current.fulfillment === "collection" && !result.restaurant.profile.collectionEnabled && result.restaurant.delivery.enabled) latest.current.onFulfillment("delivery"); updateCart(refresh ? refreshCart(latestCart.current, result.items) : []); setMenu(result.items); setNotice(refresh ? "Menu refreshed. Your basket is kept using current prices and available choices." : "");
    }
    catch (caught) { if (current()) setError((caught as Error).message); } finally { if (current()) setMenuLoading(false); }
  }

  function changeQuantity(item: MenuItem, delta: number) {
    const cart = latestCart.current, current = cart.find((entry) => entry.item.id === item.id);
    const next = Math.max(0, Math.min(20, (current?.quantity ?? 0) + delta));
    const selections = current?.selections ?? {};
    updateCart(next ? [...cart.filter((entry) => entry.item.id !== item.id), { item, quantity: next, selections }] : cart.filter((entry) => entry.item.id !== item.id));
  }
  if (props.restaurant && !browsing) return <RestaurantMenu key={props.restaurant.id} restaurant={props.restaurant} menu={menu} cart={props.cart} fulfillment={props.fulfillment} loading={loading} error={error} notice={notice} onRefresh={() => void chooseRestaurant(props.restaurant!, true)} onBack={() => { menuRequest.current++; setMenuLoading(false); setBrowsing(true); setError(""); setNotice(""); }} onFulfillment={props.onFulfillment} onQuantity={changeQuantity} onSave={(item, quantity, selections) => updateCart([...latestCart.current.filter(entry => entry.item.id !== item.id), { item, quantity, selections }])} onCheckout={props.onCheckout}/>;

  return <DiscoveryBrowse token={props.token} serviceArea={serviceArea} onLocation={selectLocation} restaurants={restaurants} offers={offers} fulfillment={props.fulfillment} onFulfillment={props.onFulfillment} postcode={postcode} onPostcode={setPostcode} query={query} onQuery={setQuery} loading={loading} error={error} onRefresh={()=>void loadRestaurants()} hasMore={hasMoreRestaurants} loadingMore={loadingMoreRestaurants} onLoadMore={()=>void loadRestaurants(true)} filters={browsingFilters} onFilters={patch=>setBrowsingFilters(old=>({...old,...patch}))} onOpen={(restaurant,offerId)=>{if(offerId&&props.onUseOffer)props.onUseOffer(restaurant.id,offerId);else void chooseRestaurant(restaurant);}}/>;
}
