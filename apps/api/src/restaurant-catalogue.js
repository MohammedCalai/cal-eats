import {HttpError} from "./http.js";

// Archiving removes a listing, never its order, payment or ownership records.
export function includeArchivedRestaurants(url){
  const value=url.searchParams.get("includeArchived");
  if(value!==null&&value!=="true"&&value!=="false")throw new HttpError(400,"VALIDATION_ERROR","includeArchived must be true or false");
  return value==="true";
}
