import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validatePlatformUpload,PLATFORM_UPLOAD_BODY_BYTES} from '../src/platform-admin-uploads.js';
const businessId='24e7cc47-fbaf-4bf7-b057-8605f6c48e88';
const pdf=Buffer.from('%PDF-1.7\nSynthetic development document\n%%EOF');
const upload=(field,bytes=pdf,name='Menu.pdf',mimeType='application/pdf')=>({field,name,mimeType,base64:bytes.toString('base64')});
const training=()=>({fields:{businessId,agent_name:' Sample agent '},files:[upload('menu_file'),upload('rules_file')]});
const invalid=fn=>assert.throws(fn,error=>error.code==='CALAI_UPLOAD_INVALID'&&error.status===400);

test('training uploads are bounded, canonical and independent of private filenames or input order',()=>{
 const first=validatePlatformUpload('createAgentUpload',training());
 const renamed=training();renamed.fields.businessId=businessId.toUpperCase();renamed.files.reverse();renamed.files[0].name='Private company rules.pdf';renamed.files[1].name='Another menu.PDF';
 const second=validatePlatformUpload('createAgentUpload',renamed);
 assert.deepEqual(first,second);assert.equal(first.fields.agent_name,'Sample agent');assert.equal(first.fields.businessId,businessId);
 assert.deepEqual(first.files.map(item=>item.field),['rules_file','menu_file']);
 assert.equal(first.files[0].sha256,createHash('sha256').update(pdf).digest('hex'));
 assert.match(first.files[0].name,/^rules_file-[a-f0-9]{16}\.pdf$/);
 assert.deepEqual(first.files[0].bytes,pdf);assert.equal(PLATFORM_UPLOAD_BODY_BYTES,16*1024*1024);
});
test('unexpected fields, missing or duplicate files and forged IDs are rejected',()=>{
 for(const mutate of [value=>{value.extra=true;},value=>{value.fields.role='SYSTEM_OWNER';},value=>{value.fields.businessId='../other';},value=>{value.fields.agent_name='\nBad';},value=>{value.files.pop();},value=>{value.files[0].field='rules_file';},value=>{value.files[0].field='secret';},value=>{value.files[0].url='https://example.test';}]){const body=training();mutate(body);invalid(()=>validatePlatformUpload('createAgentUpload',body));}
 invalid(()=>validatePlatformUpload('unknown',training()));
});
test('PDF files require canonical base64, matching type/extension and a PDF signature',()=>{
 const single=value=>validatePlatformUpload('specialOffersUpload',{fields:{assistant_id:businessId},files:[value]});
 assert.equal(single(upload('special_offers_file')).files[0].mimeType,'application/pdf');
 for(const value of [upload('special_offers_file',Buffer.from('<html>not a PDF</html>')),upload('special_offers_file',pdf,'Menu.png'),upload('special_offers_file',pdf,'Menu.pdf','image/png'),{...upload('special_offers_file'),base64:pdf.toString('base64')+'\n'},{...upload('special_offers_file'),base64:'A==='},{...upload('special_offers_file'),base64:'YR=='}])invalid(()=>single(value));
 for(const name of ['../Menu.pdf','C:\\Menu.pdf','Menu%2Fcopy.pdf','Menu.pdf\r\nheader:value','.hidden.pdf','CON.pdf'])invalid(()=>single(upload('special_offers_file',pdf,name)));
});
test('file size limits are checked before dispatch and exact PDF limit is accepted',()=>{
 const exact=Buffer.alloc(5*1024*1024,32);pdf.copy(exact);
 const body=training();body.files=[upload('rules_file',exact),upload('menu_file',exact)];
 assert.equal(validatePlatformUpload('createAgentUpload',body).files.reduce((sum,item)=>sum+item.bytes.length,0),10*1024*1024);
 body.files[0]=upload('rules_file',Buffer.concat([exact,Buffer.from('x')]));invalid(()=>validatePlatformUpload('createAgentUpload',body));
});
test('logos accept matching PNG/JPEG/WebP signatures and reject HTML, forged MIME and malformed RIFF size',()=>{
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),jpg=Buffer.from([255,216,255,224,0,0]),webp=Buffer.alloc(24);webp.write('RIFF');webp.writeUInt32LE(16,4);webp.write('WEBP',8);webp.write('VP8 ',12);webp.writeUInt32LE(4,16);
 const logo=(bytes,name,mimeType)=>validatePlatformUpload('logoUpload',{fields:{},files:[upload('logo',bytes,name,mimeType)]});
 assert.equal(logo(png,'Brand.png','image/png').files[0].mimeType,'image/png');assert.equal(logo(jpg,'Brand.jpeg','image/jpeg').files[0].name.endsWith('.jpg'),true);assert.equal(logo(webp,'Brand.webp','image/webp').files[0].mimeType,'image/webp');
 invalid(()=>logo(png,'Brand.jpg','image/jpeg'));invalid(()=>logo(Buffer.from('<svg></svg>'),'Brand.png','image/png'));
 const broken=Buffer.from(webp);broken.writeUInt32LE(500,4);invalid(()=>logo(broken,'Brand.webp','image/webp'));
 const huge=Buffer.alloc(2*1024*1024+1);png.copy(huge);invalid(()=>logo(huge,'Brand.png','image/png'));
});
