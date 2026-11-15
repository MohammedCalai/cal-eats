/** The phone is a management companion. Order processing and printing stay on
 * the restaurant tablet, including when a notification opens an order. */
export function companionRequestAllowed(path:string,method="GET"){
  const verb=method.toUpperCase(),route=path.split("?")[0]||"";
  if(!route.startsWith("/api/")||route.startsWith("//"))return false;
  if(/\.csv$|\/report-jobs\/[^/]+\/download$/.test(route))return false;
  if(/(?:^|\/)(?:print|printers?|print-jobs|print-devices|print-receipts|printer-test-receipts)(?:\/|$)/.test(route))return false;
  if(verb!=="GET"&&verb!=="HEAD"&&/^\/api\/(?:restaurant\/)?orders(?:\/|$)/.test(route)&&!route.match(/\/messages(?:\/read)?$/))return false;
  return true;
}
export function ownerAppDestination(value:Record<string,unknown>){
  const id=(key:string)=>typeof value[key]==="string"&&/^[A-Za-z0-9_-]{1,100}$/.test(value[key] as string)?value[key] as string:null;
  const restaurantId=id("restaurantId");if(!restaurantId)return null;
  if(value.kind==="device_incident"&&id("incidentId"))return {screen:"devices" as const,restaurantId,id:id("incidentId")!};
  if(id("orderId"))return {screen:"orders" as const,restaurantId,id:id("orderId")!};
  if(id("customerId"))return {screen:"messages" as const,restaurantId,id:id("customerId")!};
  return {screen:"notifications" as const,restaurantId,id:null};
}
