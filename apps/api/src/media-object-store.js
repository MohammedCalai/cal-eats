import {createHash} from "node:crypto";
import {S3Client,PutObjectCommand,HeadObjectCommand,GetObjectCommand,DeleteObjectCommand} from "@aws-sdk/client-s3";

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern=/^restaurants\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg)$/i;
export const mediaSha256=bytes=>createHash("sha256").update(bytes).digest("hex");

export function mediaObjectKey(restaurantId,assetId,mimeType){
  if(!uuid.test(restaurantId)||!uuid.test(assetId)||!["image/png","image/jpeg"].includes(mimeType))throw Error("Invalid media object identity");
  return `restaurants/${restaurantId}/${assetId}.${mimeType==="image/png"?"png":"jpg"}`;
}

// Default remains the existing database backend. Enabling a new bucket is a
// separate deployment decision; no credentials are inferred from other apps.
export function loadMediaObjectStore(input,env=process.env){
  if(input!==undefined)return input;
  const mode=env.CALAI_MEDIA_STORAGE??"database";
  if(mode==="database")return null;
  if(mode!=="s3")throw Error("CALAI_MEDIA_STORAGE must be database or s3");
  const bucket=env.CALAI_MEDIA_S3_BUCKET,region=env.CALAI_MEDIA_S3_REGION;
  if(!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket??"")||!region||region.length>80)throw Error("Private media bucket and region are required");
  const endpoint=env.CALAI_MEDIA_S3_ENDPOINT?new URL(env.CALAI_MEDIA_S3_ENDPOINT):null;
  if(endpoint&&(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=="/"))throw Error("Media object endpoint must be an HTTPS origin");
  const accessKeyId=env.CALAI_MEDIA_S3_ACCESS_KEY_ID,secretAccessKey=env.CALAI_MEDIA_S3_SECRET_ACCESS_KEY;
  if(!accessKeyId||!secretAccessKey||/[\r\n\0]/.test(accessKeyId+secretAccessKey))throw Error("Dedicated private media credentials are required");
  const forcePathStyle=env.CALAI_MEDIA_S3_FORCE_PATH_STYLE??"false";
  if(!["true","false"].includes(forcePathStyle))throw Error("Media path style must be true or false");
  const backendId=mediaSha256(`${endpoint?.origin??"aws-s3"}\n${region}\n${bucket}`);
  const client=new S3Client({region,...(endpoint?{endpoint:endpoint.origin}:{}),forcePathStyle:forcePathStyle==="true",credentials:{accessKeyId,secretAccessKey},maxAttempts:2,requestChecksumCalculation:"WHEN_REQUIRED"});
  const checkKey=key=>{if(!keyPattern.test(key))throw Error("Invalid media object key");return key;};
  const store={backendId,
    async put({key,bytes,mimeType,sha256}){
      checkKey(key);
      if(mediaSha256(bytes)!==sha256)throw Error("Media object checksum mismatch");
      const uploaded=await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentType:mimeType,CacheControl:"private, max-age=60",Metadata:{sha256},IfNoneMatch:"*"}),{abortSignal:AbortSignal.timeout(15000)});
      const versionId=uploaded.VersionId;
      if(typeof versionId!=="string"||!versionId||versionId==="null"||versionId.length>1024||/[\r\n\0]/.test(versionId))throw Error("Versioned private image storage is required for recoverable backups");
      const result=await client.send(new HeadObjectCommand({Bucket:bucket,Key:key,VersionId:versionId}),{abortSignal:AbortSignal.timeout(15000)});
      if(result.VersionId!==versionId||result.ContentLength!==bytes.length||result.Metadata?.sha256!==sha256||result.ContentType!==mimeType)throw Error("Stored media object could not be verified");
      return {versionId};
    },
    async read({key,versionId,byteLength,sha256}){
      if(typeof versionId!=="string"||!versionId)throw Error("Missing object version");
      const result=await client.send(new GetObjectCommand({Bucket:bucket,Key:checkKey(key),VersionId:versionId}),{abortSignal:AbortSignal.timeout(15000)});
      if(result.VersionId!==versionId||result.ContentLength!==byteLength||byteLength>1048576||result.Metadata?.sha256!==sha256){result.Body?.destroy?.();throw Error("Media object metadata mismatch");}
      const chunks=[];let size=0;
      const timer=setTimeout(()=>result.Body?.destroy?.(Error("Media object read timed out")),15000);
      try{for await(const chunk of result.Body){size+=chunk.length;if(size>byteLength){result.Body.destroy?.();throw Error("Media object exceeds its recorded size");}chunks.push(Buffer.from(chunk));}}finally{clearTimeout(timer);}
      const bytes=Buffer.concat(chunks);
      if(bytes.length!==byteLength||mediaSha256(bytes)!==sha256)throw Error("Media object content mismatch");
      return bytes;
    },
    // Delete the current key, never an immutable version referenced by a
    // database backup. Bucket lifecycle must retain those versions separately.
    async remove(key){await client.send(new DeleteObjectCommand({Bucket:bucket,Key:checkKey(key)}),{abortSignal:AbortSignal.timeout(15000)});}
  };
  return Object.freeze(store);
}

export function queueMediaObjectRemoval(db,mediaId,stamp){
  const object=db.prepare("SELECT object_key,backend_id FROM media_asset_objects WHERE media_id=?").get(mediaId);
  if(object)db.prepare("INSERT INTO media_object_cleanup(object_key,backend_id,available_at,created_at) VALUES(?,?,?,?) ON CONFLICT(object_key) DO NOTHING").run(object.object_key,object.backend_id,stamp,stamp);
}

export async function runMediaObjectCleanup(db,config,{limit=5}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw Error("Invalid media cleanup batch size");
  const store=config.mediaObjectStore;if(!store)return {removed:0};
  const stamp=config.now().toISOString(),rows=db.prepare("SELECT * FROM media_object_cleanup WHERE backend_id=? AND available_at<=? ORDER BY available_at,object_key LIMIT ?").all(store.backendId,stamp,limit);
  let removed=0;
  for(const row of rows){
    // A live reference always wins over an old cleanup reservation.
    if(db.prepare("SELECT 1 FROM media_asset_objects WHERE object_key=? AND backend_id=?").get(row.object_key,row.backend_id)){db.prepare("DELETE FROM media_object_cleanup WHERE object_key=?").run(row.object_key);continue;}
    try{await store.remove(row.object_key);db.prepare("DELETE FROM media_object_cleanup WHERE object_key=? AND backend_id=?").run(row.object_key,row.backend_id);removed++;}
    catch{db.prepare("UPDATE media_object_cleanup SET attempts=attempts+1,available_at=? WHERE object_key=?").run(new Date(config.now().getTime()+Math.min(86400,60*2**Math.min(row.attempts,10))*1000).toISOString(),row.object_key);}
  }
  return {removed};
}
