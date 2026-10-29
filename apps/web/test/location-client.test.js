import test from "node:test";import assert from "node:assert/strict";
import {createLocationClient} from "../location-client.js";
import {mergeLocationChoices,unavailableLocationHtml} from "../location-ui.js";
test("saved and recent addresses merge without duplicates and outside-area copy stays escaped",()=>{
 const address={label:"Home",line1:"1 Demo Road",city:"Luton",postcode:"LU1 2AB"};
 assert.equal(mergeLocationChoices([address],[{...address,label:"Recent address"}]).length,1);
 const html=unavailableLocationHtml({headline:"Outside <script>",message:"Check back soon"});assert.ok(!html.includes("<script>"));assert.ok(html.includes("&lt;script&gt;"));assert.ok(!html.includes("another address"));
});
test("GPS stores only the postcode and cancels lookup after leaving discovery",async()=>{
 const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,"navigator"),oldStorage=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");let success,calls=0;const saved=new Map();
 Object.defineProperty(globalThis,"navigator",{configurable:true,value:{geolocation:{getCurrentPosition(resolve){success=resolve;}}}});Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:{setItem:(key,value)=>saved.set(key,value),getItem:key=>saved.get(key)}});
 try{
  const state={user:{id:"customer-one",role:"customer"},generation:1,navigationVersion:1,view:"discover",postcode:""};
  const client=createLocationClient({state,api:async(route,options)=>{calls++;const body=JSON.parse(options.body);assert.equal(body.consent,true);return {postcode:"LU1 2AB",city:"Luton"};},reload:async()=>{},render:()=>{},message:()=>{}});
  const first=client.gps();success({coords:{latitude:51.88,longitude:-.42}});await first;
  assert.equal(state.postcode,"LU1 2AB");assert.equal(state.locationAddress.line1,"");assert.equal("latitude" in state.locationAddress,false);assert.deepEqual([...saved.values()],["LU1 2AB"]);
  const next=client.gps();state.view="messages";state.navigationVersion++;success({coords:{latitude:51.88,longitude:-.42}});await next;assert.equal(calls,1);
 }finally{if(oldNavigator)Object.defineProperty(globalThis,"navigator",oldNavigator);else delete globalThis.navigator;if(oldStorage)Object.defineProperty(globalThis,"sessionStorage",oldStorage);else delete globalThis.sessionStorage;}
});
