import fs from "node:fs";
import {createHash} from "node:crypto";

export function mediaObjectInventory(db,{onEntry}={}){
  const digest=createHash("sha256"),backends=new Set();let count=0,byteLength=0;
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_asset_objects'").get()){
    for(const row of db.prepare("SELECT o.*,m.restaurant_id asset_restaurant_id,m.byte_length asset_bytes,length(m.data) inline_bytes FROM media_asset_objects o JOIN media_assets m ON m.id=o.media_id ORDER BY o.media_id").iterate()){
      if(row.restaurant_id!==row.asset_restaurant_id||row.byte_length!==row.asset_bytes||row.inline_bytes!==0||!/^[a-f0-9]{64}$/.test(row.content_sha256)||!row.object_version)throw Error("Image object metadata cannot be backed up safely");
      const entry={mediaId:row.media_id,restaurantId:row.restaurant_id,backendId:row.backend_id,key:row.object_key,versionId:row.object_version,sha256:row.content_sha256,byteLength:row.byte_length};
      digest.update(JSON.stringify(entry)+"\n");onEntry?.(entry);count++;byteLength+=row.byte_length;backends.add(row.backend_id);
    }
  }
  return {count,byteLength,backendIds:[...backends].sort(),sha256:digest.digest("hex")};
}

export function writeMediaObjectManifest(db,backupPath){
  const inventory=mediaObjectInventory(db);if(!inventory.count)return null;
  const file=backupPath+".media-objects.jsonl",fd=fs.openSync(file,"wx",0o600);
  try{
    fs.writeSync(fd,JSON.stringify({contract:"cal-eats.media-backup.v1",...inventory,objectBytesIncluded:false,requiresVersionedObjectBackup:true})+"\n");
    mediaObjectInventory(db,{onEntry:entry=>fs.writeSync(fd,JSON.stringify(entry)+"\n")});
  }finally{fs.closeSync(fd);}
  return file;
}

export function assertMediaRestoreProof(inventory,proof){
  if(!inventory.count)return {status:"not_required",...inventory};
  if(!proof||proof.contract!=="cal-eats.media-verification.v1"||proof.status!=="verified"||proof.inventory?.sha256!==inventory.sha256||proof.inventory.count!==inventory.count||proof.verifiedCount!==inventory.count||JSON.stringify(proof.inventory.backendIds)!==JSON.stringify(inventory.backendIds))throw Error("Restore remains quarantined: independently verify every referenced image object version against this database snapshot and supply its pinned media verification report.");
  return {status:"verified",...inventory};
}

export function loadPinnedMediaProof(file,sha256){
  if(!file||!/^[a-f0-9]{64}$/.test(sha256??""))throw Error("A media verification file and its independently checked SHA-256 are required");
  const bytes=fs.readFileSync(file);if(createHash("sha256").update(bytes).digest("hex")!==sha256)throw Error("Media verification file checksum mismatch");
  return JSON.parse(bytes.toString("utf8"));
}
