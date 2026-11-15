import test from "node:test";
import assert from "node:assert/strict";
import {londonCalendarDate,orderDateRange,orderHistoryQuery} from "../src/order-filters.ts";

test("order date presets use the UK calendar rather than UTC or a device's local day",()=>{
  const summer=new Date("2026-07-01T23:30:00Z");
  assert.equal(londonCalendarDate(summer),"2026-07-02");assert.deepEqual(orderDateRange("today",summer),{from:"2026-07-02",to:"2026-07-02"});
  assert.deepEqual(orderDateRange("yesterday",new Date("2027-01-01T00:05:00Z")),{from:"2026-12-31",to:"2026-12-31"});
  assert.deepEqual(orderDateRange("this_week",summer),{from:"2026-06-29",to:"2026-07-02"});
  assert.deepEqual(orderDateRange("last_week",new Date("2026-11-16T00:01:00Z")),{from:"2026-11-09",to:"2026-11-15"});
  assert.deepEqual(orderDateRange("last_30_days",new Date("2026-03-30T12:00:00Z")),{from:"2026-03-01",to:"2026-03-30"});
});

test("custom history ranges reject impossible/reversed dates and keep DST boundary dates inclusive",()=>{
  for(const range of [{from:"2026-02-29",to:"2026-03-01"},{from:"2026-11-15",to:"2026-11-14"},{from:"",to:"2026-11-15"},{from:"2026-11-15",to:"2026-13-01"}])assert.throws(()=>orderDateRange("custom",new Date(),range));
  for(const day of ["2026-03-29","2026-10-25","2028-02-29"]){const range={from:day,to:day};assert.deepEqual(orderDateRange("custom",new Date(),range),range);const query=new URLSearchParams(orderHistoryQuery({page:1,status:"completed",q:"",...range}));assert.equal(query.get("from"),day);assert.equal(query.get("to"),day);}
});

test("search and dates are sent together to the paginated API without filtering a single loaded page",()=>{
  const query=new URLSearchParams(orderHistoryQuery({page:3,status:"all",q:"  Ahmed & sons #12%  ",from:"2026-10-01",to:"2026-10-31"}));
  assert.equal(query.get("page"),"3");assert.equal(query.get("pageSize"),"25");assert.equal(query.get("q"),"Ahmed & sons #12%");assert.equal(query.get("from"),"2026-10-01");assert.equal(query.get("to"),"2026-10-31");
  const reset=new URLSearchParams(orderHistoryQuery({page:1,status:"all",q:"  ",...orderDateRange("all")}));assert.equal(reset.has("q"),false);assert.equal(reset.has("from"),false);assert.equal(reset.has("to"),false);
  assert.throws(()=>orderHistoryQuery({page:1,status:"all",q:"x".repeat(101),from:"",to:""}),/100/);assert.throws(()=>orderHistoryQuery({page:0,status:"all",q:"",from:"",to:""}),/page/);
});
