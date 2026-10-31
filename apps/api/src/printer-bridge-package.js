import { readFile } from "node:fs/promises";
import { HttpError } from "./http.js";

const bridgeRoot = new URL("../../print-bridge/", import.meta.url);
const files = ["package.json", "src/index.js", "src/api-client.js", "src/bridge.js", "src/config.js", "src/credential-store.js", "src/journal.js", "src/logger.js", "src/receipt.js", "src/transports.js", "windows/install.ps1", "windows/status.ps1", "windows/uninstall.ps1"];

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit=0;bit<8;bit++) value=(value>>>1)^((value&1)?0xedb88320:0); }
  return (value^0xffffffff)>>>0;
}

// A standards-compliant, uncompressed ZIP. Every entry name is server-owned.
export function printerZip(entries) {
  const local=[],central=[];let offset=0;
  for(const [name,value] of entries){
    const filename=Buffer.from(name,"utf8"),body=Buffer.isBuffer(value)?value:Buffer.from(value,"utf8"),crc=crc32(body);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,body);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(offset,42);
    central.push(directory,filename);offset+=header.length+filename.length+body.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

export async function buildPrinterBridgePackage(printer, origin) {
  if(!printer.ip_address)throw new HttpError(409,"PRINTER_IP_REQUIRED","Add this printer’s IP address before downloading its network bridge.");
  const configuration={schemaVersion:1,product:"cal-eats",deviceName:printer.name,apiBaseUrl:origin,credentialPath:"./var/device-credential.json",journalPath:"./var/print-journal.json",logPath:"./var/print-bridge.log",transport:{kind:"tcp-escpos",enabled:true,host:printer.ip_address,port:9100,connectTimeoutMs:5000},requestTimeoutMs:5000,heartbeatIntervalMs:30000,idlePollMs:3000,retry:{maxAttempts:3,baseDelayMs:250,maxDelayMs:3000,jitterRatio:0.2}};
  const entries=await Promise.all(files.map(async file=>[file,await readFile(new URL(file,bridgeRoot))]));
  entries.push(["config.json",JSON.stringify(configuration,null,2)+"\n"],["README.txt",`Cal-Eats network printer bridge\r\n\r\nPrinter: ${printer.name}\r\nMAC: ${printer.mac_address||"Not provided"}\r\nIP: ${printer.ip_address}:9100\r\n\r\nThis separate Cal-Eats package never installs or changes the original Calai bridge. No device credential or pairing code is included. The MAC is a display identifier, not authentication. Requires an approved Node.js 24 runtime and Windows administrator setup. One Cal-Eats network-printer bridge per Windows tablet.\r\n\r\n1. Extract this ZIP to a local folder. In an elevated PowerShell window run:\r\n   .\\windows\\install.ps1 -ConfigPath .\\config.json -EnablePhysicalPrinting\r\n   This explicitly permits physical receipt output. It installs but does not start the task.\r\n2. In the Cal-Eats Printers page select Pair device for this printer. On this tablet run:\r\n   Set-Location \"$env:ProgramData\\CalEats\\PrintBridge\"\r\n   $env:CAL_EATS_PAIRING_CODE = Read-Host 'Enter the short-lived pairing code'\r\n   node src/index.js pair --config config.json\r\n   Remove-Item Env:CAL_EATS_PAIRING_CODE\r\n3. Start the separately named task after pairing:\r\n   Start-ScheduledTask -TaskName CalEatsPrintBridge\r\n4. Confirm the authenticated heartbeat on the Printers page, then test a confirmed test order against the actual printer. Online means bridge contact, not proof of paper output.\r\n\r\nThe queue prints new orders only after business confirmation. Failed or uncertain jobs require review before a labelled manual reprint. Never run two bridges against the same device credential. No paid order is created by downloading this package.\r\n`]);
  return printerZip(entries);
}
