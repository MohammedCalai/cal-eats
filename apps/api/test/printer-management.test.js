import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { journeyFixture } from "./helpers.js";
import { buildPrinterBridgePackage } from "../src/printer-bridge-package.js";
import { loadConfig } from "../../print-bridge/src/config.js";

function unzipStored(bytes){
  const entries=new Map();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){
    assert.equal(bytes.readUInt16LE(offset+8),0);
    const length=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameLength).toString("utf8"),start=offset+30+nameLength+extraLength,body=bytes.subarray(start,start+length);
    assert.equal(crc32(body),bytes.readUInt32LE(offset+14),`ZIP checksum for ${name}`);entries.set(name,body);offset=start+length;
  }
  assert.equal(bytes.readUInt32LE(offset),0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length-12),entries.size);
  return entries;
}

test("staff can see safe printer connection status without accessing printer management",async()=>{
  const f=await journeyFixture();
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],root=`/api/restaurant/restaurants/${restaurant.id}`;
    const added=await f.json(`${root}/printers`,{method:"POST",cookie:owner,body:{name:"Kitchen",enabled:true,macAddress:"AA:BB:CC:DD:EE:FF",ipAddress:"192.0.2.12"}});
    assert.equal(added.status,201,added.text);
    const created=await f.json(`${root}/staff`,{method:"POST",cookie:owner,body:{name:"Printer staff",email:"printer-staff@example.invalid",password:"PrinterStaff!4310"}});
    assert.equal(created.status,201,created.text);
    const staff=await f.login("printer-staff@example.invalid","PrinterStaff!4310"),statusPath=`${root}/printer-status`;
    const status=await f.json(statusPath,{cookie:staff});assert.equal(status.status,200,status.text);
    const kitchen=status.body.data.items.find(printer=>printer.name==="Kitchen");
    assert.deepEqual(Object.keys(kitchen).sort(),["enabled","lastSeenAt","name","revoked","status"]);
    assert.equal(kitchen.enabled,true);assert.equal(kitchen.status,"awaiting_device");assert.equal(kitchen.lastSeenAt,null);assert.equal(kitchen.revoked,false);
    assert.equal((await f.json(statusPath)).status,401);assert.equal((await f.json(statusPath,{cookie:other})).status,404);assert.equal((await f.json(statusPath,{cookie:customer})).status,403);
    assert.equal((await f.json(`${root}/printers`,{cookie:staff})).status,403);
  }finally{await f.close();}
});

test("printer management preserves old fields, normalises metadata and isolates owners and soft deletion",async()=>{
  const f=await journeyFixture();
  try{
    const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310");
    const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0],otherRestaurant=(await f.json("/api/restaurant/restaurants",{cookie:other})).body.data[0];
    const root=`/api/restaurant/restaurants/${restaurant.id}/printers`;
    let response=await f.json(root,{method:"POST",cookie:owner,body:{name:"Kitchen",enabled:true}});assert.equal(response.status,201,response.text);
    const printer=response.body.data;assert.equal(printer.macAddress,null);assert.equal(printer.ipAddress,null);
    response=await f.json(`${root}/${printer.id}`,{method:"PATCH",cookie:owner,body:{macAddress:"aa-bb-cc-dd-ee-ff",ipAddress:"192.0.2.12"}});assert.equal(response.status,200,response.text);assert.equal(response.body.data.macAddress,"AA:BB:CC:DD:EE:FF");
    assert.equal((await f.json(root,{method:"POST",cookie:owner,body:{name:"Duplicate",enabled:true,macAddress:"AABBCCDDEEFF"}})).status,409);
    assert.equal((await f.json(root,{method:"POST",cookie:owner,body:{name:"Bad MAC",enabled:true,macAddress:"bad\u0000identifier"}})).status,400);
    assert.equal((await f.json(`${root}/${printer.id}`,{method:"PATCH",cookie:owner,body:{ipAddress:"https://localhost/private"}})).status,400);
    assert.equal((await f.json(`${root}/${printer.id}`,{method:"PATCH",cookie:other,body:{name:"Wrong restaurant"}})).status,404);
    assert.equal((await f.json(root,{method:"POST",cookie:customer,body:{name:"Forbidden",enabled:true}})).status,403);
    const duplicateOther=await f.json(`/api/restaurant/restaurants/${otherRestaurant.id}/printers`,{method:"POST",cookie:other,body:{name:"Own printer",enabled:true,macAddress:"AABBCCDDEEFF",ipAddress:"192.0.2.13"}});assert.equal(duplicateOther.status,201,duplicateOther.text);
    const kit=`${root}/${printer.id}/bridge-package`;
    assert.equal((await f.request(kit)).status,401);assert.equal((await f.request(kit,{cookie:other})).status,404);
    const download=await f.request(kit,{cookie:owner});assert.equal(download.status,200);assert.equal(download.headers.get("content-type"),"application/zip");assert.equal(download.headers.get("cache-control"),"private, no-store");
    assert.equal((await f.json(`${root}/${printer.id}`,{method:"PATCH",cookie:owner,body:{revoked:true,enabled:false}})).status,200);
    assert.ok(f.db.prepare("SELECT revoked_at FROM restaurant_printers WHERE id=?").get(printer.id).revoked_at);assert.equal((await f.json(kit,{cookie:owner})).status,404);
    const replacement=await f.json(root,{method:"POST",cookie:owner,body:{name:"Replacement",enabled:true,macAddress:"AABBCCDDEEFF"}});assert.equal(replacement.status,201,replacement.text);assert.equal((await f.json(`${root}/${replacement.body.data.id}/bridge-package`,{cookie:owner})).body.error.code,"PRINTER_IP_REQUIRED");
  }finally{await f.close();}
});

test("downloaded ZIP contains only Cal-Eats bridge files, validated per-printer config and no credentials",async()=>{
  const f=await journeyFixture();
  try{
    const bytes=await buildPrinterBridgePackage({name:"Kitchen café",mac_address:"AA:BB:CC:DD:EE:FF",ip_address:"192.0.2.24"},"https://eats.calai.info");
    const files=unzipStored(bytes),config=JSON.parse(files.get("config.json").toString("utf8"));
    assert.equal(config.apiBaseUrl,"https://eats.calai.info");assert.equal(config.transport.host,"192.0.2.24");assert.equal(config.transport.kind,"tcp-escpos");assert.equal(config.deviceName,"Kitchen café");
    assert.equal(config.product,"cal-eats");assert.ok(files.has("windows/install.ps1"));assert.ok(files.has("src/index.js"));assert.ok(files.has("README.txt"));
    assert.ok(![...files.keys()].some(name=>/credential\.json|\.env|node_modules|^\.\./.test(name)));
    assert.ok(!Object.hasOwn(config,"token"));assert.ok(!Object.hasOwn(config,"pairingCode"));
    const filename=path.join(f.directory,"download-config.json");await writeFile(filename,files.get("config.json"));const parsed=await loadConfig(filename);assert.equal(parsed.apiBaseUrl,"https://eats.calai.info");
    config.apiBaseUrl="https://api.calai.info";await writeFile(filename,JSON.stringify(config));await assert.rejects(loadConfig(filename),/forbidden/);
    const installer=files.get("windows/install.ps1").toString("utf8");assert.match(installer,/EnablePhysicalPrinting/);assert.match(installer,/CalEatsPrintBridge/);assert.match(installer,/installed but not started/);
    assert.equal(files.get("src/index.js").toString("utf8"),await readFile(new URL("../../print-bridge/src/index.js",import.meta.url),"utf8"));
  }finally{await f.close();}
});


test("Calai printer identifiers accept common MAC styles and original serial numbers",async()=>{
 const f=await journeyFixture();
 try{
  const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310");
  const restaurant=(await f.json("/api/restaurant/restaurants",{cookie:owner})).body.data[0];
  const root=`/api/restaurant/restaurants/${restaurant.id}/printers`;
  const variants=[" \nAA:BB:CC:DD:EE:FF\r\n","AA\tBB CC DD EE FF","aa:bb:cc:dd:ee:ff","AA-BB-CC-DD-EE-FF","aabb.ccdd.eeff","aa bb cc dd ee ff","ＡＡ：ＢＢ：ＣＣ：ＤＤ：ＥＥ：ＦＦ","AA–BB–CC–DD–EE–FF","AA:\u200bBB:CC:DD:EE:FF"];
  for(const macAddress of variants){
   const response=await f.json(root,{method:"POST",cookie:owner,body:{name:"Format check",enabled:true,macAddress}});
   assert.equal(response.status,201,response.text);assert.equal(response.body.data.macAddress,"AA:BB:CC:DD:EE:FF");
   assert.equal((await f.json(`${root}/${response.body.data.id}`,{method:"PATCH",cookie:owner,body:{revoked:true}})).status,200);
  }
  const serial=await f.json(root,{method:"POST",cookie:owner,body:{name:"Serial printer",enabled:true,macAddress:"  EPSON-TM-T20III-SN001  "}});
  assert.equal(serial.status,201,serial.text);assert.equal(serial.body.data.macAddress,"EPSON-TM-T20III-SN001");
  assert.equal((await f.json(root,{method:"POST",cookie:owner,body:{name:"Duplicate serial",enabled:true,macAddress:"EPSON-TM-T20III-SN001"}})).status,409);
  for(const macAddress of ["bad\nserial","bad\u0000serial","bad\u202eserial","x".repeat(101)])assert.equal((await f.json(root,{method:"POST",cookie:owner,body:{name:"Invalid identifier",enabled:true,macAddress}})).status,400);
 }finally{await f.close();}
});
