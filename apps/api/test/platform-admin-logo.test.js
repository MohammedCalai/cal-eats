import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCalaiLogoUrl,validateCalaiLogoBytes} from '../src/platform-admin-logo.js';
const invalid=fn=>assert.throws(fn,error=>error.code==='CALAI_LOGO_INVALID'&&error.status===502);
test('Calai logo destination is fixed to its own uploads path',()=>{
 assert.equal(validateCalaiLogoUrl('/uploads/branding/logo.png'),'https://api.calai.info/uploads/branding/logo.png');
 assert.equal(validateCalaiLogoUrl('https://api.calai.info/uploads/Logo%20Calai.jpeg'),'https://api.calai.info/uploads/Logo%20Calai.jpeg');
 assert.equal(validateCalaiLogoUrl('/uploads/logo.webp'),'https://api.calai.info/uploads/logo.webp');
});
test('logo URLs cannot escape through another host, scheme, credentials, redirects, query or fragment',()=>{
 for(const value of ['https://example.test/uploads/logo.png','http://api.calai.info/uploads/logo.png','//example.test/uploads/logo.png','https://api.calai.info.example.test/uploads/logo.png','https://user@api.calai.info/uploads/logo.png','https://api.calai.info:444/uploads/logo.png','/uploads/logo.png?url=https://example.test','/uploads/logo.png#x','/api/system-owner/settings/logo','/uploads/logo.svg','uploads/logo.png','/uploads/'])invalid(()=>validateCalaiLogoUrl(value));
});
test('raw, encoded and double-encoded traversal or header/path injection is rejected before canonicalisation',()=>{
 for(const value of ['/uploads/../logo.png','/uploads/./logo.png','/uploads/%2e%2e/logo.png','/uploads/%252e%252e/logo.png','/uploads/a%2f..%2flogo.png','/uploads/a%5clogo.png','/uploads/logo%00.png','/uploads/a%0d%0a.png','/uploads/.secret.png','/uploads//logo.png','/uploads/%GG.png','/uploads/a\\logo.png'])invalid(()=>validateCalaiLogoUrl(value));
});
test('logo bytes are bounded and the MIME is derived from the observed image signature',()=>{
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
 assert.deepEqual(validateCalaiLogoBytes(png),{mimeType:'image/png',bytes:png});
 const jpg=Buffer.from([255,216,255,224,0]);assert.equal(validateCalaiLogoBytes(jpg).mimeType,'image/jpeg');
 const webp=Buffer.alloc(24);webp.write('RIFF');webp.writeUInt32LE(16,4);webp.write('WEBP',8);webp.write('VP8X',12);assert.equal(validateCalaiLogoBytes(webp).mimeType,'image/webp');
 invalid(()=>validateCalaiLogoBytes(Buffer.from('<svg><script/></svg>')));
 invalid(()=>validateCalaiLogoBytes(Buffer.alloc(2*1024*1024+1)));
 invalid(()=>validateCalaiLogoBytes('PNG'));
});
