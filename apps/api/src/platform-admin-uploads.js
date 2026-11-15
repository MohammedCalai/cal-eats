import {createHash} from 'node:crypto';
import {HttpError} from './http.js';

export const PLATFORM_UPLOAD_BODY_BYTES=16*1024*1024;
const PDF_LIMIT=5*1024*1024,IMAGE_LIMIT=2*1024*1024;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bad=message=>{throw new HttpError(400,'CALAI_UPLOAD_INVALID',message);};
function exact(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))bad('The upload fields are invalid.');
}
function filename(value){
 if(typeof value!=='string'||value.length<1||value.length>180||value!==value.trim()||value.startsWith('.')||/[\u0000-\u001f\u007f/\\:"<>|?*%]/.test(value)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))bad('Choose a file with a plain filename and the correct extension.');
 return value.toLowerCase().split('.').at(-1);
}
function decode(value,limit){
 // Check the encoded bound before allocating a binary copy. The round trip
 // rejects permissive decoder aliases, missing padding and hidden whitespace.
 if(typeof value!=='string'||!value.length||value.length>4*Math.ceil(limit/3)||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))bad('The uploaded file is invalid or too large.');
 const bytes=Buffer.from(value,'base64');
 if(!bytes.length||bytes.length>limit||bytes.toString('base64')!==value)bad('The uploaded file is invalid or too large.');
 return bytes;
}
export function platformImageType(bytes){
 if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png',extensions:['png']};
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',ext:'jpg',extensions:['jpg','jpeg']};
 if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16)))return {mime:'image/webp',ext:'webp',extensions:['webp']};
 return null;
}
function file(value,field,image=false){
 exact(value,['field','name','mimeType','base64']);
 if(value.field!==field)bad('The upload file fields are invalid.');
 const ext=filename(value.name),bytes=decode(value.base64,image?IMAGE_LIMIT:PDF_LIMIT);
 let mimeType='application/pdf',extension='pdf';
 if(image){
  const detected=platformImageType(bytes);
  if(!detected||value.mimeType!==detected.mime||!detected.extensions.includes(ext))bad('Choose a PNG, JPEG or WebP image with a matching filename.');
  mimeType=detected.mime;extension=detected.ext;
 }else if(value.mimeType!==mimeType||ext!=='pdf'||bytes.length<5||bytes.toString('ascii',0,5)!=='%PDF-')bad('Choose a PDF document with a matching filename.');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 // Upstream storage needs a filename, not the private local filename. Using
 // the content digest also keeps a renamed retry bound to the same intent.
 return {field,name:`${field}-${sha256.slice(0,16)}.${extension}`,mimeType,bytes,sha256};
}
function id(value){if(typeof value!=='string'||!UUID.test(value))bad('Choose an available Calai account or agent.');return value.toLowerCase();}

export function validatePlatformUpload(kind,body){
 exact(body,['fields','files']);
 let fields,required,image=false;
 if(kind==='createAgentUpload'){
  exact(body.fields,['businessId','agent_name']);
  const name=body.fields.agent_name;
  if(typeof name!=='string'||!name.trim()||name.trim().length>100||/[\u0000-\u001f\u007f]/.test(name))bad('Enter an agent name of up to 100 characters.');
  fields={businessId:id(body.fields.businessId),agent_name:name.trim()};required=['rules_file','menu_file'];
 }else if(kind==='specialOffersUpload'){
  exact(body.fields,['assistant_id']);fields={assistant_id:id(body.fields.assistant_id)};required=['special_offers_file'];
 }else if(kind==='logoUpload'){
  exact(body.fields,[]);fields={};required=['logo'];image=true;
 }else bad('This Calai upload is unavailable.');
 if(!Array.isArray(body.files)||body.files.length!==required.length||body.files.some(item=>!item||typeof item!=='object'||!required.includes(item.field))||new Set(body.files.map(item=>item.field)).size!==required.length)bad('Choose all required files once.');
 const files=required.map(field=>file(body.files.find(item=>item.field===field),field,image));
 if(files.reduce((sum,item)=>sum+item.bytes.length,0)>10*1024*1024)bad('Keep the combined upload below 10 MB.');
 return {fields,files};
}
