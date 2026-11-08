import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {journeyFixture} from "./helpers.js";
import {loadMediaObjectStore,mediaObjectKey,mediaSha256,runMediaObjectCleanup} from "../src/media-object-store.js";
import fs from "node:fs";
import path from "node:path";
import {BACKUP_ROOT,createBackup} from "../../../scripts/backup.js";
import {inspectDatabase} from "../../../scripts/restore-check.js";
import {mediaObjectInventory,assertMediaRestoreProof} from "../../../scripts/media-object-manifest.js";
import {verifyMediaObjects} from "../../../scripts/verify-media-objects.js";
import {DatabaseSync} from "node:sqlite";

const png="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=",image={mimeType:"image/png",dataBase64:png};
function memoryStore(){const objects=new Map(),versions=new Map(),calls=[];return {backendId:"fixture-storage",objects,versions,calls,
  async put(input){calls.push("put");objects.set(input.key,Buffer.from(input.bytes));versions.set(input.key,Buffer.from(input.bytes));return {versionId:"version-fixture"};},
  async read(input){calls.push("read");assert.equal(input.versionId,"version-fixture");return versions.get(input.key);},
  async remove(key){calls.push("remove");objects.delete(key);}
};}
async function setup(){const f=await journeyFixture(),store=memoryStore();f.config.mediaObjectStore=store;const owner=await f.login("restaurant@calai.local","LocalRestaurant!4310"),other=await f.login("restaurant2@calai.local","LocalRestaurant2!4310"),customer=await f.login("customer@calai.local","LocalCustomer!4310"),restaurant=f.db.prepare("SELECT * FROM restaurants WHERE name='Calai Kitchen'").get(),second=f.db.prepare("SELECT * FROM restaurants WHERE name='Second Spoon'").get();return {...f,store,owner,other,customer,restaurant,second};}

test("media storage is opt-in with isolated credentials and tenant UUID object keys",()=>{
  assert.equal(loadMediaObjectStore(undefined,{}),null);
  for(const env of [{CALAI_MEDIA_STORAGE:"public"},{CALAI_MEDIA_STORAGE:"s3"},{CALAI_MEDIA_STORAGE:"s3",CALAI_MEDIA_S3_BUCKET:"private-images",CALAI_MEDIA_S3_REGION:"auto",CALAI_MEDIA_S3_ENDPOINT:"http://insecure.test"}])assert.throws(()=>loadMediaObjectStore(undefined,env));
  assert.throws(()=>mediaObjectKey("../escape",randomUUID(),"image/png"));
  const tenant=randomUUID(),asset=randomUUID();assert.equal(mediaObjectKey(tenant,asset,"image/png"),`restaurants/${tenant}/${asset}.png`);
});

test("object photos preserve public URL, quota and authorization without image BLOBs in the order database",async()=>{
  const s=await setup();try{
    const cover=`/api/restaurant/restaurants/${s.restaurant.id}/cover`,created=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(created.status,201,created.text);
    const row=s.db.prepare("SELECT m.*,o.object_key,o.content_sha256 FROM media_assets m JOIN media_asset_objects o ON o.media_id=m.id WHERE m.id=?").get(created.body.data.id);
    assert.equal(row.data.length,0);assert.equal(row.byte_length,Buffer.from(png,"base64").length);assert.equal(created.body.data.storage.usedBytes,row.byte_length);assert.equal(row.content_sha256,mediaSha256(Buffer.from(png,"base64")));
    assert.match(row.object_key,new RegExp(`^restaurants/${s.restaurant.id}/`));assert.equal((await s.request(created.body.data.url,{cookie:s.customer})).status,200);
    const privatePhoto=await s.json(`/api/restaurant/restaurants/${s.second.id}/cover`,{method:"POST",cookie:s.other,body:image});assert.equal(privatePhoto.status,201,privatePhoto.text);
    const reads=s.store.calls.filter(c=>c==="read").length;assert.equal((await s.request(privatePhoto.body.data.url,{cookie:s.customer})).status,404);assert.equal(s.store.calls.filter(c=>c==="read").length,reads,"Private image denied before object storage access");
    assert.equal((await s.request(privatePhoto.body.data.url,{cookie:s.other})).status,200);
    const replaced=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(replaced.status,201,replaced.text);assert.equal(s.db.prepare("SELECT id FROM media_assets WHERE id=?").get(row.id),undefined);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media_object_cleanup").get().n,1);assert.equal((await runMediaObjectCleanup(s.db,s.config)).removed,1);assert.equal(s.store.objects.has(row.object_key),false);
    await s.json(cover,{method:"DELETE",cookie:s.owner});assert.equal((await runMediaObjectCleanup(s.db,s.config)).removed,1);assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media_asset_objects WHERE restaurant_id=?").get(s.restaurant.id).n,0);assert.deepEqual(s.db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{await s.close();}
});

test("failed and raced uploads retain the old photo and durably clean abandoned objects",async()=>{
  const s=await setup();try{
    const cover=`/api/restaurant/restaurants/${s.restaurant.id}/cover`,first=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(first.status,201);
    const old=s.db.prepare("SELECT cover_media_id FROM restaurants WHERE id=?").get(s.restaurant.id).cover_media_id;
    const original=s.store.put;s.store.put=async input=>{await original(input);throw Error("ambiguous private failure never exposed");};
    const failed=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(failed.status,503);assert.equal(failed.body.error.code,"MEDIA_STORAGE_UNAVAILABLE");assert.equal(failed.text.includes("ambiguous"),false);assert.equal(s.db.prepare("SELECT cover_media_id FROM restaurants WHERE id=?").get(s.restaurant.id).cover_media_id,old);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media_object_cleanup").get().n,1);
    s.store.put=async input=>{const saved=await original(input);s.db.prepare("INSERT INTO media_assets VALUES(?,?,'image/png',X'00',1,1,100000000,?)").run(randomUUID(),s.restaurant.id,s.config.now().toISOString());return saved;};
    const raced=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(raced.status,409);assert.equal(raced.body.error.code,"MEDIA_LIMIT");assert.equal(s.db.prepare("SELECT cover_media_id FROM restaurants WHERE id=?").get(s.restaurant.id).cover_media_id,old);
    s.db.prepare("UPDATE media_object_cleanup SET available_at='2020-01-01T00:00:00.000Z'").run();assert.equal((await runMediaObjectCleanup(s.db,s.config)).removed,2);
    const object=s.db.prepare("SELECT object_key FROM media_asset_objects WHERE media_id=?").get(old);assert.equal(s.store.objects.has(object.object_key),true,"Cleanup cannot remove the active image");
  }finally{await s.close();}
});

test("storage mismatch and corrupted object bytes fail closed; database photos still work",async()=>{
  const s=await setup();try{
    const cover=`/api/restaurant/restaurants/${s.restaurant.id}/cover`,external=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(external.status,201);
    const object=s.db.prepare("SELECT * FROM media_asset_objects WHERE media_id=?").get(external.body.data.id);s.store.versions.set(object.object_key,Buffer.from("wrong"));assert.equal((await s.request(external.body.data.url)).status,503);
    s.config.mediaObjectStore={...s.store,backendId:"different-bucket"};assert.equal((await s.request(external.body.data.url)).status,503);
    s.config.mediaObjectStore=null;assert.equal((await s.request(external.body.data.url)).status,503);
    const legacy=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(legacy.status,201);assert.equal((await s.request(legacy.body.data.url)).status,200);
  }finally{await s.close();}
});

test("in-flight object reads recheck visibility and versioned backup retains replaced photos",async()=>{
  const s=await setup(),backupPath=path.join(BACKUP_ROOT,`media-objects-${randomUUID()}.sqlite`);try{
    const cover=`/api/restaurant/restaurants/${s.restaurant.id}/cover`,first=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(first.status,201);
    const read=s.store.read;s.store.read=async input=>{s.db.prepare("UPDATE restaurants SET suspended=1 WHERE id=?").run(s.restaurant.id);return read(input);};
    assert.equal((await s.request(first.body.data.url)).status,404,"Suspension while awaiting storage takes effect before bytes are sent");
    s.db.prepare("UPDATE restaurants SET suspended=0 WHERE id=?").run(s.restaurant.id);s.store.read=read;
    await createBackup({source:s.config.dbPath,destination:backupPath});assert.ok(fs.existsSync(backupPath+".media-objects.jsonl"));
    const second=await s.json(cover,{method:"POST",cookie:s.owner,body:image});assert.equal(second.status,201);await runMediaObjectCleanup(s.db,s.config);
    const backup=new DatabaseSync(backupPath,{readOnly:true});try{
      const inventory=mediaObjectInventory(backup);assert.throws(()=>assertMediaRestoreProof(inventory,null),/quarantined/);
      const proof=await verifyMediaObjects(backup,s.store);assert.equal(proof.verifiedCount,1,"Deleted key retains its exact version for restoring old backups");assert.equal(assertMediaRestoreProof(inventory,proof).status,"verified");
      assert.throws(()=>assertMediaRestoreProof(inventory,{...proof,inventory:{...proof.inventory,sha256:"0".repeat(64)}}),/quarantined/);
      assert.equal(inspectDatabase(backupPath,{mediaProof:proof}).media.status,"verified");
    }finally{backup.close();}
  }finally{await s.close();for(const file of [backupPath,backupPath+".media-objects.jsonl"]){assert.equal(path.dirname(file),BACKUP_ROOT);fs.rmSync(file,{force:true});}}
});
