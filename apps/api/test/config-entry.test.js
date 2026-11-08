import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("configuration can be the first module loaded by a fresh CLI process",()=>{
  const config=new URL("../src/config.js",import.meta.url).href,runtime=new URL("../src/customer-push.js",import.meta.url).href,schema=new URL("../src/customer-push-migration.js",import.meta.url).href;
  const source=`const config=await import(${JSON.stringify(config)});if(typeof config.loadConfig!=='function')throw Error('Configuration export missing');const runtime=await import(${JSON.stringify(runtime)});const schema=await import(${JSON.stringify(schema)});if(runtime.customerPushMigration44!==schema.customerPushMigration44||schema.customerPushMigration44.version!==44||schema.customerPushMigration44.name!=='customer_native_push')throw Error('Migration compatibility changed');`;
  const child=spawnSync(process.execPath,["--input-type=module","-e",source],{encoding:"utf8",timeout:10000,windowsHide:true});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,"");
});
