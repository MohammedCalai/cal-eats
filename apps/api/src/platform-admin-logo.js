import {HttpError} from './http.js';
import {CALAI_ORIGIN} from './platform-admin-config.js';
import {platformImageType} from './platform-admin-uploads.js';

const invalid=()=>{throw new HttpError(502,'CALAI_LOGO_INVALID','The Calai logo image is unavailable.');};
export function validateCalaiLogoUrl(value){
 if(typeof value!=='string'||!value.length||value.length>2048||/[\u0000-\u001f\u007f\\?#]/.test(value))invalid();
 // Validate the raw path before URL() could erase dot segments. There is no
 // client-selected destination, arbitrary CDN, credential or query forwarding.
 const path=value.startsWith(CALAI_ORIGIN+'/')?value.slice(CALAI_ORIGIN.length):value;
 if(!path.startsWith('/uploads/')||path.startsWith('//'))invalid();
 const segments=path.slice(1).split('/');
 if(segments.length<2||segments.length>8)invalid();
 for(const segment of segments){
  let decoded;try{decoded=decodeURIComponent(segment);}catch{invalid();}
  if(!decoded||decoded!==decoded.trim()||decoded.startsWith('.')||decoded==='..'||/[\u0000-\u001f\u007f/\\%:"<>|?*#]/.test(decoded))invalid();
 }
 const extension=segments.at(-1).toLowerCase().split('.').at(-1);
 if(!['png','jpg','jpeg','webp'].includes(extension))invalid();
 let url;try{url=new URL(path,CALAI_ORIGIN);}catch{invalid();}
 if(url.origin!==CALAI_ORIGIN||url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/uploads/'))invalid();
 return url.href;
}
export function validateCalaiLogoBytes(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>2*1024*1024)invalid();
 const type=platformImageType(bytes);if(!type)invalid();
 return {mimeType:type.mime,bytes};
}
