import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
const root=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const names=["package.json","src/protocol.js","src/windows-key.js","src/device.js","src/broker.js","src/index.js","windows/terminal-key.ps1"];
export function buildTerminalInstaller(){
 const files=names.map(name=>{const bytes=fs.readFileSync(path.join(root,name));return{name,bytes:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")};});
 const payload=gzipSync(Buffer.from(JSON.stringify({schemaVersion:1,files})));
 const template=fs.readFileSync(new URL("./install-template.ps1",import.meta.url),"utf8");
 return template.replace("__PAYLOAD_BASE64__",payload.toString("base64")).replace("__PAYLOAD_SHA256__",createHash("sha256").update(payload).digest("hex")).replace(/\r?\n/g,"\r\n");
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const destination=process.argv[2];if(!destination)throw Error("An output path is required.");
 const output=buildTerminalInstaller();fs.writeFileSync(destination,output,{mode:0o600});
 console.log(JSON.stringify({bytes:Buffer.byteLength(output),assets:names.length,output:destination}));
}
