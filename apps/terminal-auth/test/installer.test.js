import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildTerminalInstaller} from '../windows/build-installer.mjs';

test('tablet-specific installers bind the recorded serial before installation and cannot override it',()=>{
 const bound=buildTerminalInstaller({targetSerial:'026300301451'});
 assert.ok(bound.includes("$TerminalBoundSerial='026300301451'"));
 assert.match(bound,/\$TargetSerial -ne \$TerminalBoundSerial\) \{ throw/);
 assert.match(bound,/SerialNumber\)\.Trim\(\) -ne \$TerminalExpectedSerial\) \{ throw/);
 assert.ok(bound.indexOf('$TerminalExpectedSerial=')<bound.indexOf('$TerminalRoot='));
 assert.ok(buildTerminalInstaller().includes("$TerminalBoundSerial=''"));
 assert.equal(bound.includes('__TARGET_SERIAL__'),false);
});

test('installer serial input cannot inject PowerShell code or exceed inventory bounds',()=>{
 for(const targetSerial of [null,42,'x\r\nWrite-Output bad',"x';throw 'bad",'x`n','x$()', 'x'.repeat(121),' leading']){
  assert.throws(()=>buildTerminalInstaller({targetSerial}),/Invalid target tablet serial/);
 }
 assert.doesNotThrow(()=>buildTerminalInstaller({targetSerial:'Surface Go-1/Loc:2_A.3'}));
});

test('serial-bound download keeps the authenticated companion payload and per-file integrity',()=>{
 const unbound=buildTerminalInstaller();
 const bound=buildTerminalInstaller({targetSerial:'026300301451'});
 const payload=/\$PayloadBase64='([^']+)'/.exec(bound)?.[1]??/FromBase64String\('([^']+)'\)/.exec(bound)?.[1];
 assert.ok(payload,'installer must contain its packaged payload');
 assert.ok(unbound.includes(payload));
 const bytes=Buffer.from(payload,'base64');
 assert.ok(bound.includes(createHash('sha256').update(bytes).digest('hex')));
 const manifest=JSON.parse(gunzipSync(bytes));
 assert.equal(manifest.schemaVersion,1);
 assert.ok(manifest.files.some(file=>file.name==='src/windows-key.js'));
 for(const file of manifest.files)assert.equal(createHash('sha256').update(Buffer.from(file.bytes,'base64')).digest('hex'),file.sha256);
});

test('Windows PowerShell parses both installer variants without running them',{skip:process.platform!=='win32'},()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'caleats-installer-parse-'));
 try{
  for(const [name,serial] of [['owner',''],['central','026300301451']]){
   const file=path.join(directory,`${name}.ps1`);
   writeFileSync(file,buildTerminalInstaller({targetSerial:serial}));
   const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'","''")}',[ref]$null,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`],{encoding:'utf8',timeout:15000,windowsHide:true});
   assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  }
 }finally{rmSync(directory,{recursive:true,force:true});}
});
