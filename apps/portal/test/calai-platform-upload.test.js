import test from "node:test";
import assert from "node:assert/strict";
import {calaiUploadLimits,readCalaiUploadFile,validateCalaiFileSelection} from "../src/calai-platform-upload.js";
const file=(name,bytes,type="")=>({name,type,size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
const pdf=Array.from(new TextEncoder().encode("%PDF-1.7\nselected document\n%%EOF"));
test("user-selected PDFs are encoded canonically without transmitting their private filenames",async()=>{
 const selected=file("Private business rules.pdf",pdf,"application/pdf"),result=await readCalaiUploadFile(selected,"rules_file","pdf");
 assert.deepEqual(Object.keys(result),["field","name","mimeType","base64"]);assert.equal(result.field,"rules_file");assert.equal(result.name,"rules_file.pdf");assert.equal(result.mimeType,"application/pdf");assert.equal(atob(result.base64),new TextDecoder().decode(Uint8Array.from(pdf)));assert.equal(result.base64,Buffer.from(pdf).toString("base64"));assert.equal(JSON.stringify(result).includes(selected.name),false);
 assert.equal((await readCalaiUploadFile(file("Menu.PDF",pdf),"menu_file","pdf")).name,"menu_file.pdf");
});
test("oversized, changed, mislabeled and non-PDF files are rejected before any upload body is built",async()=>{
 let read=false;assert.throws(()=>validateCalaiFileSelection({name:"large.pdf",size:calaiUploadLimits.pdf+1,arrayBuffer:()=>{read=true;}},"pdf"),/5 MiB/);assert.equal(read,false);
 assert.throws(()=>validateCalaiFileSelection({name:"logo.png",size:calaiUploadLimits.logo+1},"logo"),/2 MiB/);
 for(const name of ["../rules.pdf","a\\rules.pdf","bad\nname.pdf"]){assert.throws(()=>validateCalaiFileSelection(file(name,pdf),"pdf"),/filename/);}
 await assert.rejects(readCalaiUploadFile(file("renamed.pdf",[60,104,116,109,108,62],"application/pdf"),"rules_file","pdf"),/actual PDF/);
 await assert.rejects(readCalaiUploadFile(file("rules.png",pdf),"rules_file","pdf"),/extension/);
 await assert.rejects(readCalaiUploadFile({...file("rules.pdf",pdf),size:pdf.length+1},"rules_file","pdf"),/changed/);
 await assert.rejects(readCalaiUploadFile(file("rules.pdf",pdf,"image/png"),"rules_file","pdf"),/reported type/);
});
test("logo formats need matching signatures, extensions and a valid bounded WebP container",async()=>{
 const png=[137,80,78,71,13,10,26,10,0],jpeg=[255,216,255,224,0],webp=[82,73,70,70,12,0,0,0,87,69,66,80,86,80,56,88,0,0,0,0];
 assert.equal((await readCalaiUploadFile(file("Brand.PNG",png,"image/png"),"logo","logo")).mimeType,"image/png");
 assert.equal((await readCalaiUploadFile(file("Brand.jpg",jpeg,"image/jpeg"),"logo","logo")).name,"logo.jpeg");
 assert.equal((await readCalaiUploadFile(file("Brand.webp",webp,"image/webp"),"logo","logo")).mimeType,"image/webp");
 const badLength=[...webp];badLength[4]=100;await assert.rejects(readCalaiUploadFile(file("bad.webp",badLength),"logo","logo"),/actual PNG/);
 const badChunk=[...webp];badChunk[12]=0;await assert.rejects(readCalaiUploadFile(file("bad.webp",badChunk),"logo","logo"),/actual PNG/);
 await assert.rejects(readCalaiUploadFile(file("Logo.png",Array.from(new TextEncoder().encode("<svg></svg>"))),"logo","logo"),/SVG/);
 await assert.rejects(readCalaiUploadFile(file("Brand.png",png),"rules_file","logo"),/correct upload/);
});
