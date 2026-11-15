import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import {HttpError} from './http.js';
export const CALAI_ORIGIN='https://api.calai.info';
export const PLATFORM_SESSION_MS=4*60*60*1000;
export function loadPlatformAdminConfig(input={}, {runMode='local'}={}){
 const enabled=input.enabled??(process.env.CALAI_PLATFORM_ADMIN_ENABLED==='true');
 if(typeof enabled!=='boolean')throw Error('Platform administrator activation must be a boolean');
 const origin=input.origin??process.env.CALAI_PLATFORM_ADMIN_ORIGIN??CALAI_ORIGIN;
 if(origin!==CALAI_ORIGIN)throw Error('Platform administrator API origin must be https://api.calai.info');
 const encoded=input.encryptionKey??process.env.CALAI_PLATFORM_ADMIN_ENCRYPTION_KEY??null;
 if(encoded!==null&&(typeof encoded!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(encoded)||Buffer.from(encoded,'base64url').length!==32))throw Error('Platform administrator encryption key must be a private 32-byte base64url value');
 if(enabled&&!encoded)throw Error('Platform administrator login requires its own private encryption key');
 if(input.adapter&&runMode!=='local')throw Error('Injected platform administrator adapters are local-test only');
 if(input.readOnly!==undefined&&typeof input.readOnly!=='boolean')throw Error('Platform administrator read-only setting must be a boolean');
 const readOnlyEnvironment=process.env.CALAI_PLATFORM_ADMIN_READ_ONLY;
 if(readOnlyEnvironment!==undefined&&!['true','false'].includes(readOnlyEnvironment))throw Error('CALAI_PLATFORM_ADMIN_READ_ONLY must be true or false');
 const readOnly=input.readOnly??(readOnlyEnvironment!=='false');
 const responseLimitBytes=Number(input.responseLimitBytes??process.env.CALAI_PLATFORM_ADMIN_RESPONSE_LIMIT_BYTES??8*1024*1024);
 if(!Number.isSafeInteger(responseLimitBytes)||responseLimitBytes<1024*1024||responseLimitBytes>32*1024*1024)throw Error('Platform administrator data response limit must be from1MiB to32MiB');
 return Object.freeze({enabled,origin,encryptionKey:encoded,adapter:input.adapter??null,responseLimitBytes,readOnly});
}
const key=config=>Buffer.from(config.platformAdmin.encryptionKey,'base64url');
export function encryptPlatformTokens(config,value,aad){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(config),iv);cipher.setAAD(Buffer.from(aad));
 return ['v1',iv.toString('base64url'),Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptPlatformTokens(config,value,aad){
 try{const [version,iv,data,tag,...extra]=String(value).split('.');if(version!=='v1'||extra.length)throw Error();const decipher=createDecipheriv('aes-256-gcm',key(config),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8'));}
 catch{throw new HttpError(401,'PLATFORM_SESSION_INVALID','Reconnect your platform administrator account.');}
}
export const platformRequestHash=(config,value)=>createHmac('sha256',key(config)).update('cal-eats-platform-request-v1\n').update(value).digest('hex');
