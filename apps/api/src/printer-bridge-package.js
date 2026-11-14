import { readFile } from "node:fs/promises";
import { HttpError } from "./http.js";

const bridgeRoot = new URL("../../print-bridge/", import.meta.url);
const files = ["package.json", "src/index.js", "src/api-client.js", "src/bridge.js", "src/config.js", "src/credential-store.js", "src/journal.js", "src/logger.js", "src/receipt.js", "src/transports.js", "src/setup.js", "src/shared-calai.js", "src/patch-calai.js", "src/instance-lock.js", "calai-native/shared-prefix.txt", "calai-native/shared-suffix.txt", "calai-native/supported-hashes.json", "windows/connect-shared-calai.ps1", "windows/install.ps1", "windows/status.ps1", "windows/uninstall.ps1"];

const automaticInstaller=String.raw`param([string]$NodePath = "")
$ErrorActionPreference = "Stop"
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$PrincipalCheck = New-Object Security.Principal.WindowsPrincipal($Identity)
if (-not $PrincipalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($NodePath -match '["\r\n]') { throw "The selected runtime path is invalid." }
    $Arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
    if ($NodePath) { $Arguments += @('-NodePath', ('"' + $NodePath + '"')) }
    Write-Host "Allow the Windows administrator prompt to install Cal-Eats printer setup."
    try {
        $Installer = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
        if ($Installer.ExitCode -ne 0) { throw "Printer setup was not completed. Run install.ps1 as administrator to see the details." }
        exit 0
    } catch { throw "Windows administrator approval is needed to finish printer setup. $($_.Exception.Message)" }
}
$InstallArguments = @{ ConfigPath = (Join-Path $PSScriptRoot "config.json") }
if ($NodePath) { $InstallArguments.NodePath = $NodePath }
& (Join-Path $PSScriptRoot "windows\install.ps1") @InstallArguments
`;

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

export async function buildPrinterBridgePackage(printer, origin, {setup=null} = {}) {
  if(!printer.ip_address)throw new HttpError(409,"PRINTER_IP_REQUIRED","Add this printer’s IP address before downloading printer setup.");
  const configuration={schemaVersion:1,product:"cal-eats",deviceName:printer.name,apiBaseUrl:origin,credentialPath:"./var/device-credential.json",journalPath:"./var/print-journal.json",logPath:"./var/print-bridge.log",transport:{kind:"tcp-escpos",enabled:true,host:printer.ip_address,port:9100,connectTimeoutMs:5000},requestTimeoutMs:5000,heartbeatIntervalMs:15000,idlePollMs:3000,retry:{maxAttempts:3,baseDelayMs:250,maxDelayMs:3000,jitterRatio:0.2}};
  const entries=await Promise.all(files.map(async file=>[file,await readFile(new URL(file,bridgeRoot))]));
  if(setup){
    if(setup.product!=="cal-eats"||setup.printerId!==printer.id||setup.restaurantId!==printer.restaurant_id||typeof setup.code!=="string")throw new Error("Printer setup binding is invalid");
    entries.push(["config.json",JSON.stringify(configuration,null,2)+"\n"],["setup.json",JSON.stringify(setup,null,2)+"\n"]);
    entries.push(["install.ps1",automaticInstaller.replace(/\r?\n/g,"\r\n")]);
    entries.push(["start.bat",'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"\r\nif errorlevel 1 pause\r\n']);
    entries.push(["README.txt",[
      "CAL-EATS PRINTER SETUP", "", `Printer: ${String(printer.name).replace(/[\r\n\x00-\x1f]/g," ")}`, "",
      "CALAI-MANAGED SURFACE WITH THE SHARED-BRIDGE UPDATE:",
      "Download this ZIP while signed in as the Business User and leave it in Downloads. The managed setup connects Cal-Eats to that Surface's existing Calai bridge. Restart the bridge or Surface once to load the update.", "",
      "OTHER WINDOWS DEVICES:",
      "Extract the complete ZIP and run start.bat with administrator approval. An existing supported Calai bridge is reused with its printer settings and runtime; restart that bridge once. If no Calai bridge is present, the standard Cal-Eats background connection is installed.", "",
      "Return to Cal-Eats > Printers. When Connected appears, select Test print and check the sample receipt.", "",
      `This private setup works once for this printer and must first be used before ${setup.expiresAt}. Download a fresh setup for another device or after expiry. No manual pairing code or customer payment is needed.`, "",
      "Calai and Cal-Eats keep their own order queues and credentials. Shared printing uses the existing Calai printer routine, printer address and startup. Confirmed Cal-Eats orders queue automatically. Do not start extra copies for the same printer.", "",
      "Connected means the printer network port was recently reachable. Check paper output before requesting a labelled reprint after an uncertain result.", "",
    ].join("\r\n")]);
    return printerZip(entries);
  }
  throw new HttpError(410,"PRINTER_SETUP_UPDATED","Download automatic printer setup from the Cal-Eats printer settings.");
}
