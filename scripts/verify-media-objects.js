import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {createHash} from "node:crypto";
import {loadMediaObjectStore,mediaSha256} from "../apps/api/src/media-object-store.js";
import {mediaObjectInventory} from "./media-object-manifest.js";

export async function verifyMediaObjects(db,store){
  db.exec("BEGIN");
  try{
  const inventory=mediaObjectInventory(db);let verifiedCount=0;
  if(inventory.count&&!store)throw Error("The matching private image storage connection is required");
  if(inventory.backendIds.some(id=>id!==store?.backendId))throw Error("The image storage connection does not match the snapshot");
  if(inventory.count)for(const row of db.prepare("SELECT * FROM media_asset_objects ORDER BY media_id").iterate()){
    const bytes=await store.read({key:row.object_key,versionId:row.object_version,byteLength:row.byte_length,sha256:row.content_sha256});
    if(bytes.length!==row.byte_length||mediaSha256(bytes)!==row.content_sha256)throw Error("An image object version did not match the snapshot");
    verifiedCount++;
  }
  return {contract:"cal-eats.media-verification.v1",status:"verified",checkedAt:new Date().toISOString(),inventory,verifiedCount,readOnly:true};
  }finally{db.exec("ROLLBACK");}
}

async function main(){
  const [source,output,...extra]=process.argv.slice(2);
  if(!source||!output||extra.length||!source.endsWith(".sqlite"))throw Error("Usage: node --env-file=<private-media-settings> scripts/verify-media-objects.js <isolated-backup.sqlite> <private-proof.json>");
  const db=new DatabaseSync(path.resolve(source),{readOnly:true});let report;
  try{db.exec("PRAGMA query_only=ON");report=await verifyMediaObjects(db,loadMediaObjectStore());}finally{db.close();}
  const bytes=Buffer.from(JSON.stringify(report,null,2)+"\n");fs.writeFileSync(path.resolve(output),bytes,{flag:"wx",mode:0o600});
  console.log(JSON.stringify({verifiedImages:report.verifiedCount,proofFile:path.resolve(output),sha256:createHash("sha256").update(bytes).digest("hex")}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error("Image version verification failed; restore remains quarantined. Check the matching private connection and object-version backup.");process.exitCode=1;});
