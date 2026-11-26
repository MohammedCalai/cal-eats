import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand,DeleteObjectCommand} from "@aws-sdk/client-s3";
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

const backblazeSettings = {
  CALAI_MEDIA_STORAGE: "b2",
  CALAI_MEDIA_S3_BUCKET: "private-cal-eats-test",
  CALAI_MEDIA_S3_REGION: "eu-central-003",
  CALAI_MEDIA_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com",
  CALAI_MEDIA_S3_ACCESS_KEY_ID: "synthetic-key-id",
  CALAI_MEDIA_S3_SECRET_ACCESS_KEY: "synthetic-key-value",
  CALAI_MEDIA_S3_FORCE_PATH_STYLE: "true",
};

test("B2 opt-in requires the provider's regional HTTPS origin; S3 still uses atomic conditional uploads", async t => {
  for (const endpoint of [undefined, "https://s3.eu-central-004.backblazeb2.com", "https://s3.eu-central-003.backblazeb2.com.example.invalid", "https://s3.eu-central-003.backblazeb2.com:444"]) {
    assert.throws(() => loadMediaObjectStore(undefined, { ...backblazeSettings, CALAI_MEDIA_S3_ENDPOINT: endpoint }), /regional HTTPS endpoint/);
  }
  const store = loadMediaObjectStore(undefined, { ...backblazeSettings, CALAI_MEDIA_STORAGE: "s3" });
  const key = mediaObjectKey(randomUUID(), randomUUID(), image.mimeType), bytes = Buffer.from(png, "base64"), sha256 = mediaSha256(bytes);
  t.mock.method(S3Client.prototype, "send", async function (command) {
    assert.equal(await this.config.maxAttempts(), 2);
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, "*");
      return { VersionId: "s3-version" };
    }
    assert.ok(command instanceof HeadObjectCommand);
    assert.equal(command.input.VersionId, "s3-version");
    return { VersionId: "s3-version", ContentLength: bytes.length, ContentType: image.mimeType, Metadata: { sha256 } };
  });
  assert.deepEqual(await store.put({ key, bytes, sha256, mimeType: image.mimeType }), { versionId: "s3-version" });
});

test("B2 sends a single-attempt append and reads each verified version after a newer write and hide marker", async t => {
  const store = loadMediaObjectStore(undefined, backblazeSettings);
  const key = mediaObjectKey(randomUUID(), randomUUID(), image.mimeType), versions = new Map();
  let omitVersion = false, acknowledgeMarker = true, hidden = false;
  const transport = t.mock.method(S3Client.prototype, "send", async function (command) {
    const input = command.input;
    assert.equal(input.Key, key);
    if (command instanceof PutObjectCommand) {
      assert.equal(await this.config.maxAttempts(), 1);
      assert.equal(input.IfNoneMatch, undefined);
      if (omitVersion) return {};
      const id = `b2-version-${versions.size + 1}`;
      versions.set(id, { bytes: input.Body, sha256: input.Metadata.sha256, mimeType: input.ContentType });
      return { VersionId: id };
    }
    assert.equal(await this.config.maxAttempts(), 2);
    if (command instanceof DeleteObjectCommand) {
      assert.equal(input.VersionId, undefined, "cleanup never deletes a specific version");
      if (!acknowledgeMarker) return {};
      hidden = true;
      return { DeleteMarker: true };
    }
    assert.ok(command instanceof HeadObjectCommand || command instanceof GetObjectCommand);
    const saved = versions.get(input.VersionId);
    assert.ok(saved, "verification and reads always select an existing exact version, even after hide");
    return { VersionId: input.VersionId, ContentLength: saved.bytes.length, ContentType: saved.mimeType,
      Metadata: { sha256: saved.sha256 }, ...(command instanceof GetObjectCommand ? { Body: Readable.from([saved.bytes]) } : {}) };
  });

  const original = Buffer.from(png, "base64"), newer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQjr0JAAHoAVLonYB/AAAAAElFTkSuQmCC", "base64");
  const put = async bytes => {
    const sha256 = mediaSha256(bytes);
    const { versionId } = await store.put({ key, bytes, mimeType: image.mimeType, sha256 });
    return { key, versionId, byteLength: bytes.length, sha256 };
  };
  const first = await put(original);
  const second = await put(newer);
  assert.notEqual(first.versionId, second.versionId);
  assert.deepEqual(await store.read(first), original);
  assert.deepEqual(await store.read(second), newer);
  acknowledgeMarker = false;
  await assert.rejects(store.remove(key), /hide marker/);
  acknowledgeMarker = true;
  await store.remove(key);
  assert.equal(hidden, true);
  assert.deepEqual(await store.read(first), original);
  assert.deepEqual(await store.read(second), newer);

  const callsBeforeInvalid = transport.mock.callCount();
  await assert.rejects(store.read({ ...first, versionId: "null" }), /Missing immutable object version/);
  assert.equal(transport.mock.callCount(), callsBeforeInvalid);
  omitVersion = true;
  await assert.rejects(put(original), /Versioned private image storage/);
  assert.equal(transport.mock.callCount(), callsBeforeInvalid + 1, "unversioned upload cannot reach publication verification");
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
