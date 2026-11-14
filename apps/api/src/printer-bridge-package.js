import { readFile } from "node:fs/promises";
import { HttpError } from "./http.js";

const bridgeRoot = new URL("../../print-bridge/", import.meta.url);
const files = ["package.json", "src/index.js", "src/api-client.js", "src/bridge.js", "src/config.js", "src/credential-store.js", "src/journal.js", "src/logger.js", "src/receipt.js", "src/transports.js", "src/setup.js", "windows/install.ps1", "windows/status.ps1", "windows/uninstall.ps1"];

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
    entries.push(["README.txt",`CAL-EATS PRINTER SETUP\r\n\r\nPrinter: ${String(printer.name).replace(/[\r\n\x00-\x1f]/g," ")}\r\nPrinter address: ${printer.ip_address}:9100\r\n\r\n1. Extract this complete ZIP on the Windows device connected to your printer.\r\n2. Double-click start.bat and allow the Windows administrator prompt, or deploy install.ps1 as SYSTEM through Microsoft Intune. It configures this printer automatically and starts the background connection.\r\n3. Return to Cal-Eats > Printers. When Connected appears, select Test print and check the sample receipt.\r\n\r\nThe setup code is private, works once for this printer only, and must first be used before ${setup.expiresAt}. It is consumed automatically. No manual pairing code or customer/order/payment is needed. Download a fresh setup if it expires or you install on another device.\r\n\r\nThe installed connection starts with Windows, keeps its saved credentials and print journal through updates, and is independent of the original Calai installation. Internet access to eats.calai.info and local network access to the printer are required. If Node.js 24 is missing, the installer obtains a verified official runtime.\r\n\r\nAfter setup, confirmed orders are queued automatically. Do not run multiple copies for the same printer. A lost connection during printing is shown as uncertain; check paper before requesting a labelled reprint. Connected means the printer network port was recently reachable, not proof of paper output.\r\n`]);
    return printerZip(entries);
  }
  throw new HttpError(410,"PRINTER_SETUP_UPDATED","Download automatic printer setup from the Cal-Eats printer settings.");
}
