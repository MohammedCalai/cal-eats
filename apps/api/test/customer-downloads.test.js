import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { customerDownloadConfig, preserveCustomerWebFlow } from "../src/customer-downloads.js";
import { serveStatic } from "../src/static.js";
import { accessLinkDestination, initializeDownloads, preserveCustomerWebFlow as clientPreserve, publicStoreDestination, storePlatform } from "../../web/download.js";

const ios="https://apps.apple.com/gb/app/cal-eats/id6831180948";
const android="https://play.google.com/store/apps/details?id=uk.co.calai.caleats";

test("public downloads require explicit release flags and exact Cal-Eats store identities",()=>{
  assert.deepEqual(customerDownloadConfig({}),{ios:{available:false,url:null},android:{available:false,url:null}});
  assert.equal(customerDownloadConfig({CALAI_IOS_PUBLIC_APP_URL:ios}).ios.available,false);
  const config=customerDownloadConfig({CALAI_IOS_PUBLIC_APP_AVAILABLE:"true",CALAI_IOS_PUBLIC_APP_URL:ios,CALAI_ANDROID_PUBLIC_APP_AVAILABLE:"true",CALAI_ANDROID_PUBLIC_APP_URL:android});
  assert.equal(config.ios.url,ios);assert.equal(config.android.url,android);
  for(const bad of ["https://testflight.apple.com/join/anything","https://apps.apple.com/gb/app/cal-eats/id123","https://apps.apple.com.evil.test/gb/app/cal-eats/id6831180948",ios+"#secret",ios+"?token=x","https://user:pass@apps.apple.com/app/id6831180948"]){assert.throws(()=>customerDownloadConfig({CALAI_IOS_PUBLIC_APP_AVAILABLE:"true",CALAI_IOS_PUBLIC_APP_URL:bad}));assert.equal(publicStoreDestination({ios:{available:true,url:bad}},"ios"),null);}
  for(const bad of ["https://play.google.com/apps/internaltest/4700960164758478673",android+"&token=x",android.replace("uk.co.calai.caleats","another.app"),android+"&id=uk.co.calai.caleats"]){assert.throws(()=>customerDownloadConfig({CALAI_ANDROID_PUBLIC_APP_AVAILABLE:"true",CALAI_ANDROID_PUBLIC_APP_URL:bad}));assert.equal(publicStoreDestination({android:{available:true,url:bad}},"android"),null);}
});

test("device routing handles Android, iPhone and touch iPad without forwarding account links",async()=>{
  assert.equal(storePlatform({userAgent:"Mozilla Android"}),"android");assert.equal(storePlatform({userAgent:"Mozilla iPhone"}),"ios");assert.equal(storePlatform({userAgent:"Mozilla Macintosh",platform:"MacIntel",maxTouchPoints:5}),"ios");assert.equal(storePlatform({userAgent:"Mozilla Macintosh",platform:"MacIntel",maxTouchPoints:0}),null);
  let destination=null,fetches=0;
  const node={dataset:{store:"ios"},disabled:true,querySelector:()=>({textContent:""}),addEventListener:()=>{}};
  const document={body:{dataset:{autoDownload:"true"}},querySelectorAll:selector=>selector==="[data-store]"?[node]:[]};
  const location={hash:"",search:"?orderId=private",replace:value=>destination=value};
  await initializeDownloads({document,location,navigator:{userAgent:"iPhone"},fetch:async()=>{fetches++;return {ok:true,json:async()=>({ios:{available:true,url:ios}})};}});
  assert.equal(destination,ios);assert.equal(node.disabled,false);assert.equal(fetches,1);
  destination=null;location.hash="#reset-password=private-token";
  await initializeDownloads({document,location,navigator:{userAgent:"iPhone"},fetch:async()=>{throw Error("must not fetch");}});
  assert.equal(destination,"/account-access/#reset-password=private-token");assert.equal(accessLinkDestination("#arbitrary=private-token"),null);
  destination=null;location.hash="#verify-email=verification-secret";
  await initializeDownloads({document,location,navigator:{userAgent:"iPhone"},fetch:async()=>{throw Error("Verification must be routed before store lookup");}});
  assert.equal(destination,"/account-access/#verify-email=verification-secret");
  location.hash="";destination=null;node.disabled=true;
  await initializeDownloads({document,location,navigator:{userAgent:"iPhone"},fetch:async()=>({ok:true,json:async()=>customerDownloadConfig({})})});
  assert.equal(destination,null);assert.equal(node.disabled,true);
  await initializeDownloads({document,location,navigator:{userAgent:"iPhone"},fetch:async()=>{throw Error("offline");}});
  assert.equal(destination,null);
});

test("hosted customer entry is app-first while local preview, recovery and checkout/application paths survive",async()=>{
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,"http://localhost");const mode=url.searchParams.has("local")?"local":"hosted-preview";if(!await serveStatic(req,res,url.pathname,{runMode:mode,customerDownloadEnv:{}}))res.writeHead(404).end();}catch{res.writeHead(500).end();}});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const path of ["/order","/order/","/order/?view=account","/download/"]){const response=await fetch(origin+path);assert.equal(response.status,200,path);const html=await response.text();assert.match(html,/data-auto-download="true"/,path);assert.doesNotMatch(html,/\btest\b|sample restaurants|simulated|testflight\.apple|internaltest/i,path);}
    for(const path of ["/order/?local=1","/account-access/","/order/?payment_order=owned-order&payment_cancelled=1","/order/?view=register-restaurant"]){const response=await fetch(origin+path);const html=await response.text();assert.equal(response.status,200,path);assert.match(html,/id="main"/,path);assert.doesNotMatch(html,/data-auto-download=/,path);if(path.includes("local=1"))assert.doesNotMatch(html,/data-app-first=/);else assert.match(html,/data-app-first="true"/);}
    for(const path of ["/","/support","/support/"]){const response=await fetch(origin+path);const html=await response.text();assert.equal(response.status,200);assert.doesNotMatch(html,/\btest\b|sample restaurants|simulated|testflight\.apple|internaltest/i);assert.match(html,/\/business\/login/);}
    const business=await fetch(origin+"/business/login");assert.equal(business.status,200);assert.doesNotMatch(await business.text(),/data-auto-download=/);
    const links=await fetch(origin+"/app-downloads.json");assert.equal(links.headers.get("cache-control"),"no-store");assert.deepEqual(await links.json(),customerDownloadConfig({}));
    for(const path of ["/download.js","/landing.js","/landing.css"]){assert.equal((await fetch(origin+path)).status,200,path);}
    // Receipts, legal routes and APIs are not captured by the download gate.
    for(const path of ["/api/orders/owned/receipt","/privacy/","/terms/","/api/auth/me"]){assert.equal((await fetch(origin+path)).status,404,path);}
    for(const search of ["?payment_order=owned-order","?view=register-restaurant","?view=account","?payment_order="]){assert.equal(preserveCustomerWebFlow(search),clientPreserve(search));}
  }finally{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));}
});
