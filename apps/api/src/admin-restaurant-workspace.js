import { randomUUID } from "node:crypto";
import {includeArchivedRestaurants} from "./restaurant-catalogue.js";
import { requireRole } from "./auth/authorization.js";
import { scopedAdminRestaurantSession } from "./auth/admin-restaurant-scope.js";
import { HttpError, sendJson } from "./http.js";
import { orderDto, restaurantDto, routeJourney } from "./journey.js";
import { routePolish } from "./polish.js";
import { routeLoyalty } from "./loyalty.js";
import { routeCustomerRelationships } from "./customer-relationships.js";
import { parseLondonDateRange } from "./marketplace-reporting.js";

const like = value => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const number = (url, key, fallback, max) => {
  const value = url.searchParams.get(key) ?? String(fallback);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(+value) || +value > max) throw new HttpError(400,"VALIDATION_ERROR",`${key} is invalid`);
  return +value;
};
const pagination = (page,pageSize,total) => ({page,pageSize,total,totalPages:Math.ceil(total/pageSize),hasNext:page*pageSize<total,hasPrevious:page>1});
const missing = () => new HttpError(404,"NOT_FOUND","Restaurant not found");

export async function routeAdminRestaurantWorkspace(context) {
  const {req,res,url,db,config,session}=context;
  if(url.pathname==="/api/admin/restaurant-promotions"&&req.method==="GET"){
    requireRole(session,"admin");const page=number(url,"page",1,100000),pageSize=25,q=(url.searchParams.get("q")??"").trim();if(q.length>100)throw new HttpError(400,"VALIDATION_ERROR","Search is too long");
    const where="r.archived_at IS NULL AND (c.title LIKE ? ESCAPE '\\' OR r.name LIKE ? ESCAPE '\\')",values=[like(q),like(q)],total=db.prepare(`SELECT COUNT(*) n FROM offer_campaigns c JOIN restaurants r ON r.id=c.restaurant_id WHERE ${where}`).get(...values).n,now=config.now().toISOString();
    const items=db.prepare(`SELECT c.id,c.restaurant_id,c.title,c.starts_at,c.expires_at,r.name restaurant_name,(SELECT COUNT(*) FROM offer_grants g WHERE g.campaign_id=c.id AND g.status='redeemed') redeemed FROM offer_campaigns c JOIN restaurants r ON r.id=c.restaurant_id WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT ? OFFSET ?`).all(...values,pageSize,(page-1)*pageSize).map(row=>({id:row.id,restaurantId:row.restaurant_id,restaurantName:row.restaurant_name,title:row.title,startsAt:row.starts_at,expiresAt:row.expires_at,redeemedCount:row.redeemed,status:row.expires_at<=now?"Ended":row.starts_at>now?"Scheduled":"Active"}));
    return sendJson(res,200,{data:{items,pagination:pagination(page,pageSize,total)}});
  }
  if(url.pathname==="/api/admin/restaurant-directory"&&req.method==="GET"){
    requireRole(session,"admin");
    const page=number(url,"page",1,100000),pageSize=number(url,"pageSize",25,100),q=(url.searchParams.get("q")??"").trim(),status=url.searchParams.get("status")??"all";
    if(q.length>100||!["all","approved","pending","rejected","suspended"].includes(status))throw new HttpError(400,"VALIDATION_ERROR","Restaurant filters are invalid");
    const filters=includeArchivedRestaurants(url)?["1=1"]:["archived_at IS NULL"],values=[];
    if(q){filters.push("(name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR cuisine LIKE ? ESCAPE '\\')");values.push(like(q),like(q),like(q));}
    if(status==="suspended")filters.push("suspended=1");else if(status!=="all"){filters.push("status=?");values.push(status);}
    const where=filters.join(" AND "),total=db.prepare(`SELECT COUNT(*) n FROM restaurants WHERE ${where}`).get(...values).n;
    const items=db.prepare(`SELECT * FROM restaurants WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?`).all(...values,pageSize,(page-1)*pageSize).map(row=>restaurantDto(row,{privateDetails:true,now:config.now(),db}));
    return sendJson(res,200,{data:{items,pagination:pagination(page,pageSize,total)}});
  }
  const match=url.pathname.match(/^\/api\/admin\/restaurants\/([^/]+)\/(workspace|manage)(?:\/(.*))?$/);
  if(!match)return false;
  const admin=requireRole(session,"admin"),restaurantId=match[1],restaurant=db.prepare("SELECT * FROM restaurants WHERE id=?").get(restaurantId);
  if(!restaurant)throw missing();
  const tail=match[3]??"";
  if(match[2]==="workspace"){
    if(req.method!=="GET")throw new HttpError(405,"METHOD_NOT_ALLOWED","Method not allowed");
    if(!tail){
      const counts=db.prepare("SELECT COUNT(*) total,SUM(status IN ('placed','accepted','preparing','ready','out_for_delivery')) live,SUM(status='completed') completed FROM orders WHERE restaurant_id=?").get(restaurantId);
      const owner=db.prepare("SELECT u.name,u.email,u.phone FROM restaurant_memberships m JOIN users u ON u.id=m.user_id WHERE m.restaurant_id=? AND m.permission='owner' ORDER BY m.created_at LIMIT 1").get(restaurantId);
      return sendJson(res,200,{data:{restaurant:restaurantDto(restaurant,{privateDetails:true,now:config.now(),db}),owner:owner??null,counts:{orders:counts.total,live:counts.live??0,completed:counts.completed??0,menuItems:db.prepare("SELECT COUNT(*) n FROM menu_items WHERE restaurant_id=?").get(restaurantId).n},supportUrl:`/admin/support?restaurant=${encodeURIComponent(restaurantId)}`}});
    }
    if(tail==="orders"){
      const page=number(url,"page",1,100000),pageSize=number(url,"pageSize",25,100),state=url.searchParams.get("state")??"live",q=(url.searchParams.get("q")??"").trim(),range=parseLondonDateRange(url);
      if(!["live","past","all"].includes(state)||q.length>100)throw new HttpError(400,"VALIDATION_ERROR","Order filters are invalid");
      const conditions=["o.restaurant_id=?"],values=[restaurantId];
      if(state==="live")conditions.push("o.status IN ('placed','accepted','preparing','ready','out_for_delivery')");
      if(state==="past")conditions.push("o.status IN ('completed','rejected')");
      if(q){conditions.push("(o.id LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");values.push(like(q),like(q),like(q));}
      if(range.from){conditions.push("o.created_at>=?");values.push(range.from);}if(range.toExclusive){conditions.push("o.created_at<?");values.push(range.toExclusive);}
      const where=conditions.join(" AND "),total=db.prepare(`SELECT COUNT(*) n FROM orders o JOIN users u ON u.id=o.customer_id WHERE ${where}`).get(...values).n;
      const items=db.prepare(`SELECT o.*,u.name customer_name,u.email customer_email FROM orders o JOIN users u ON u.id=o.customer_id WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT ? OFFSET ?`).all(...values,pageSize,(page-1)*pageSize).map(row=>({...orderDto(db,row,true,true,config),customerName:row.customer_name,customerEmail:row.customer_email}));
      return sendJson(res,200,{data:{items,pagination:pagination(page,pageSize,total)}});
    }
    if(tail==="access-candidates"){
      const page=number(url,"page",1,100000),pageSize=25,q=(url.searchParams.get("q")??"").trim();if(q.length>100)throw new HttpError(400,"VALIDATION_ERROR","Search is too long");
      const where="u.role='restaurant' AND u.account_enabled=1 AND NOT EXISTS(SELECT 1 FROM restaurant_memberships m WHERE m.restaurant_id=? AND m.user_id=u.id) AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')",values=[restaurantId,like(q),like(q)],total=db.prepare(`SELECT COUNT(*) n FROM users u WHERE ${where}`).get(...values).n;
      const items=db.prepare(`SELECT u.id,u.name,u.email FROM users u WHERE ${where} ORDER BY u.name COLLATE NOCASE,u.id LIMIT ? OFFSET ?`).all(...values,pageSize,(page-1)*pageSize);
      return sendJson(res,200,{data:{items,pagination:pagination(page,pageSize,total)}});
    }
    throw new HttpError(404,"NOT_FOUND","Resource not found");
  }
  if(tail==="delivery"&&req.method!=="GET")throw new HttpError(403,"OWNER_DELIVERY_SETTINGS_REQUIRED","Only the business owner can change delivery fees and delivery settings. Administrators can inspect the current settings in the restaurant overview.");
  // Only these existing owner operations are exposed. Payments, order transitions,
  // delivery settings, printers, customer-message sending and account credentials are deliberately absent.
  const permitted=(/^menu(?:\/(?:order|import|[^/]+(?:\/photo)?))?$/.test(tail)&&["GET","POST","PATCH","PUT","DELETE"].includes(req.method))
    ||(tail==="cover"&&req.method==="DELETE")
    ||(tail==="profile"&&req.method==="PATCH")
    ||(tail==="loyalty"&&req.method==="GET")
    ||(/^loyalty\/promotions(?:\/[^/]+(?:\/end)?)?$/.test(tail)&&["GET","POST","PATCH"].includes(req.method))
    ||(/^customers(?:\/[^/]+\/profile)?$/.test(tail)&&req.method==="GET");
  if(!permitted)throw new HttpError(404,"NOT_FOUND","Resource not found");
  const managedUrl=new URL(url);managedUrl.pathname=`/api/restaurant/restaurants/${restaurantId}/${tail}`;
  let status=200;
  const managedResponse=Object.create(res);
  managedResponse.writeHead=(code,headers)=>{status=code;return res.writeHead(code,headers);};
  managedResponse.end=body=>{
    if(status<300&&req.method!=="GET")db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)").run(randomUUID(),admin.id,"restaurant",restaurantId,"admin_restaurant_managed",JSON.stringify({method:req.method,resource:tail}),config.now().toISOString());
    return res.end(body);
  };
  const managed={...context,url:managedUrl,res:managedResponse,session:scopedAdminRestaurantSession(session,restaurantId)};
  for(const handler of [routePolish,routeLoyalty,routeCustomerRelationships,routeJourney]){
    const handled=await handler(managed);if(handled||res.headersSent||res.writableEnded)return true;
  }
  throw new HttpError(404,"NOT_FOUND","Resource not found");
}
