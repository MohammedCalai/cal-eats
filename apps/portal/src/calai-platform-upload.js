export const calaiUploadLimits={pdf:5*1024*1024,logo:2*1024*1024};
export function validateCalaiFileSelection(file,kind){
 const limit=kind==="logo"?calaiUploadLimits.logo:calaiUploadLimits.pdf;
 if(!file||typeof file.name!=="string"||!file.name||file.name.length>120||/[\\/\u0000-\u001f\u007f]/.test(file.name)||file.name==="."||file.name==="..")throw Error("Choose a file with a normal filename of up to 120 characters.");
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>limit)throw Error(kind==="logo"?"Choose a logo image up to 2 MiB.":"Choose a PDF up to 5 MiB.");
 return file;
}
function fileMime(bytes,kind){
 if(kind!=="logo")return bytes.length>=5&&String.fromCharCode(...bytes.subarray(0,5))==="%PDF-"?"application/pdf":null;
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return "image/png";
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return "image/jpeg";
 if(bytes.length>=20&&String.fromCharCode(...bytes.subarray(0,4))==="RIFF"&&new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(4,true)===bytes.length-8&&String.fromCharCode(...bytes.subarray(8,12))==="WEBP"&&["VP8 ","VP8L","VP8X"].includes(String.fromCharCode(...bytes.subarray(12,16))))return "image/webp";
 return null;
}
export async function readCalaiUploadFile(file,field,kind){
 validateCalaiFileSelection(file,kind);
 if(!["rules_file","menu_file","special_offers_file","logo"].includes(field)||kind==="logo"&&field!=="logo"||kind!=="logo"&&field==="logo")throw Error("Choose a file for the correct upload field.");
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.length!==file.size)throw Error("The selected file changed while being read. Choose it again.");
 const mimeType=fileMime(bytes,kind);
 if(!mimeType)throw Error(kind==="logo"?"Choose an actual PNG, JPEG or WebP image. SVG and other file types are not accepted.":"Choose an actual PDF document. Renaming another file to .pdf does not convert it.");
 const declared=String(file.type||"").toLowerCase();
 if(declared&&declared!==mimeType&&declared!=="application/octet-stream")throw Error("The file's reported type does not match its contents. Choose a correctly exported file.");
 const extension=file.name.split(".").at(-1)?.toLowerCase(),allowed={"application/pdf":["pdf"],"image/png":["png"],"image/jpeg":["jpg","jpeg"],"image/webp":["webp"]};
 if(!allowed[mimeType].includes(extension))throw Error("The filename extension must match the file's actual type.");
 let binary="";for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
 return {field,name:`${field}.${mimeType==="image/jpeg"?"jpeg":extension}`,mimeType,base64:btoa(binary)};
}
