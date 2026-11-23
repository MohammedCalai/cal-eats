import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {TerminalDevice,readManagedSetup} from "../src/device.js";
import {managedSetupPoller} from "../src/index.js";
import {encodeManagedEvidence,requestAllowed} from "../src/protocol.js";
import {buildManagedTerminalInstaller,buildTerminalInstaller} from "../windows/build-installer.mjs";

const jobId="11111111-1111-4111-8111-111111111111";
const entraDeviceId="2a222222-2222-4222-8222-222222222222";
const otherJob="33333333-3333-4333-8333-333333333333";
const businessId="44444444-4444-4444-8444-444444444444";
const targetSerial="OFFLINE-SYNTHETIC-TABLET";
const challenge="h".repeat(43),target="/api/terminal-devices/managed-enrolment";

async function temp(t){
  const parent=await fs.realpath(os.tmpdir());
  const folder=await fs.mkdtemp(path.join(parent,"caleats-managed-offline-"));
  t.after(async()=>{
    const actual=await fs.realpath(folder);
    assert.equal(path.dirname(actual).toLowerCase(),parent.toLowerCase());
    assert.match(path.basename(actual),/^caleats-managed-offline-/);
    await fs.rm(actual,{recursive:true,force:true});
  });
  return folder;
}

test("managed installer is deterministic and contains only the public selected-device data",()=>{
  const script=buildManagedTerminalInstaller({targetSerial,entraDeviceId,jobId});
  const embedded=/\$TerminalManagedSetupBase64='([A-Za-z0-9+/=]+)'/.exec(script)?.[1];
  assert.deepEqual(JSON.parse(Buffer.from(embedded,"base64")),{jobId,entraDeviceId});
  assert.equal(buildManagedTerminalInstaller({jobId,entraDeviceId,targetSerial}),script);
  assert.match(script,/\$TerminalBoundSerial='OFFLINE-SYNTHETIC-TABLET'/);
  assert.match(script,/\$TerminalEmbeddedEnrolmentBase64=''/);
  assert.match(buildTerminalInstaller(),/\$TerminalManagedSetupBase64=''/);
  assert.match(script,/\$TerminalIdentity.User.Value -cne 'S-1-5-18'/);
  assert.match(script,/Set-ScheduledTask -TaskName \$TerminalTaskName -TaskPath '\\' -Action \$Action/);
  assert.match(script,/\$ReuseManagedRelease -or \$RestartManagedBroker -or \$ExistingTask.State -ne 'Running'/);
  assert.doesNotMatch(script,/(?:Set-ItemProperty|Register-Printer|Set-Printer|Remove-Printer|Restart-Computer)/);
  for(const overrides of [
    {jobId:"00000000-0000-0000-0000-000000000000"},{jobId:"FOREIGN"},
    {entraDeviceId:null},{entraDeviceId:entraDeviceId.toUpperCase()},
    {targetSerial:""},{targetSerial:"trailing "},{targetSerial:"x';throw 'injection"},
    {enrolment:"not-allowed"},{apiBaseUrl:"https://other.invalid"},{expiresAt:"not-allowed"},
  ])assert.throws(()=>buildManagedTerminalInstaller({targetSerial,entraDeviceId,jobId,...overrides}));
});

test("Windows PowerShell 5.1 parses managed installer and quietly rejects missing, wrong and ambiguous join proofs",
  {skip:process.platform!=="win32"},async t=>{
  const directory=await temp(t),installer=path.join(directory,"generated.ps1");
  await fs.writeFile(installer,buildManagedTerminalInstaller({targetSerial,entraDeviceId,jobId}));
  const joined="| Device State |\r\n AzureAdJoined : YES\r\n | Détails de l’appareil |\r\n DeviceId : "+entraDeviceId.toUpperCase()+"\r\n";
  const cases=[
    [joined,true],[joined.replaceAll("\r\n","\n"),true],
    [joined.replace("YES","NO"),false],[joined.replace("DeviceId","WorkplaceDeviceId"),false],
    [joined.replace(entraDeviceId.toUpperCase(),otherJob),false],[joined+"DeviceId : "+entraDeviceId+"\n",false],
    [joined+"AzureAdJoined : NO\n",false],["DeviceId : "+entraDeviceId+"\n",false],
    [joined+"\0".repeat(65537),false],
  ];
  await fs.writeFile(path.join(directory,"cases.json"),JSON.stringify({expected:entraDeviceId,cases:cases.map(([output,ok])=>({output,ok}))}));
  const runner=[
    "$ErrorActionPreference='Stop'",
    "$parseErrors=$null",
    "$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'generated.ps1'),[ref]$null,[ref]$parseErrors)",
    "if ($parseErrors.Count) { throw $parseErrors[0].Message }",
    "$fn=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-TerminalManagedJoin'},$true)",
    "if (-not $fn) { throw 'Missing join parser' }",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "$inputData=Get-Content -LiteralPath (Join-Path (Get-Location) 'cases.json') -Raw -Encoding UTF8 | ConvertFrom-Json",
    "foreach ($case in $inputData.cases) { if ((Test-TerminalManagedJoin $case.output $inputData.expected) -ne $case.ok) { throw 'Join proof validation mismatch' } }",
    "$text=$tree.Extent.Text",
    "$firstWrite=$text.IndexOf('Initialize-TerminalDirectory $TerminalRoot')",
    "if ($firstWrite -lt 0 -or $text.IndexOf('Test-TerminalManagedJoin (Read-TerminalDeviceJoin)') -ge $firstWrite) { throw 'Join verification happens after writes' }",
    "if ($text.IndexOf('Assert-TerminalManagedState $IdentityPath $ManagedPath $ManualPath') -ge $firstWrite) { throw 'Managed assignment verification happens after writes' }",
    "Write-Output 'offline-managed-validation-ok'",
  ].join("\r\n");
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",runner],{cwd:directory,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(result.stdout.trim(),"offline-managed-validation-ok");
});

test("managed installation recovers only canonical expired legacy files with no prior identity",
  {skip:process.platform!=="win32"},async t=>{
  const directory=await temp(t);
  await fs.writeFile(path.join(directory,"generated.ps1"),buildManagedTerminalInstaller({targetSerial,entraDeviceId,jobId}));
  const expired={terminalId:otherJob,businessId,code:"a".repeat(32),challenge,apiBaseUrl:"https://eats.calai.info",expiresAt:"2020-01-01T00:00:00.000Z"};
  const setup8={schemaVersion:1,product:"calai-business-terminal",...expired};
  const serialize=value=>JSON.stringify(value);
  const cases=[
    {id:"six",raw:serialize(expired),accepted:true},
    {id:"eight",raw:serialize(setup8),accepted:true},
    {id:"unexpired",raw:serialize({...expired,expiresAt:"2099-01-01T00:00:00.000Z"})},
    {id:"noncanon-date",raw:serialize({...expired,expiresAt:"2020-01-01T00:00:00Z"})},
    {id:"noncanon-origin",raw:serialize({...expired,apiBaseUrl:"https://eats.calai.info/"})},
    {id:"seven",raw:serialize({schemaVersion:1,...expired})},
    {id:"unknown",raw:serialize({...expired,otherField:"not-canonical"})},
    {id:"duplicate",raw:serialize(expired).replace('"code":','"code":"a","code":')},
    {id:"escaped-key",raw:serialize(expired).replace('"code":','"co\\u0064e":')},
    {id:"wrong-code",raw:serialize({...expired,code:"short"})},
    {id:"broken",raw:"{no-json"},
    {id:"public-acl",raw:serialize(expired),unsafe:true},
    ...[true,false].map(paired=>({id:paired?"paired":"unpaired",raw:serialize(expired),
      identity:{schemaVersion:1,product:"calai-business-terminal",terminalId:jobId,businessId,paired}})),
  ];
  for(const scenario of cases){
    await fs.writeFile(path.join(directory,scenario.id+".json"),scenario.raw);
    if(scenario.identity)await fs.writeFile(path.join(directory,scenario.id+"-identity.json"),serialize(scenario.identity));
  }
  await fs.writeFile(path.join(directory,"cases.json"),serialize(cases.map(({id,accepted,unsafe})=>({id,accepted:Boolean(accepted),unsafe:Boolean(unsafe)}))));
  const script=[
    "$ErrorActionPreference='Stop'",
    "$parseErrors=$null",
    "$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'generated.ps1'),[ref]$null,[ref]$parseErrors)",
    "if ($parseErrors.Count) { throw $parseErrors[0].Message }",
    "$names=@('Assert-TerminalEnrolmentData','Assert-TerminalSetupIdentity','Get-TerminalExpiredLegacyId','Assert-TerminalManagedState')",
    "foreach ($name in $names) {",
    " $fn=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)",
    " if (-not $fn) { throw 'Missing setup validator' }",
    " . ([scriptblock]::Create($fn.Extent.Text))",
    "}",
    "function Assert-TerminalPrivateFile { param([string]$path) if ($script:untrusted) { throw 'Unsafe ACL' } }",
    "function Move-Item { throw 'Read-only validator attempted to move a file' }",
    "$cases=Get-Content -LiteralPath 'cases.json' -Raw -Encoding UTF8 | ConvertFrom-Json",
    "foreach ($case in $cases) {",
    " $script:untrusted=$case.unsafe",
    " $manual=Join-Path (Get-Location) ($case.id+'.json')",
    " $identity=Join-Path (Get-Location) ($case.id+'-identity.json')",
    " $before=Get-Content -LiteralPath $manual -Raw",
    " $expected=if ($case.accepted) {'"+otherJob+"'} else {$null}",
    " $actual=$null",
    " try { $actual=Assert-TerminalManagedState $identity 'fixture-no-managed-setup' $manual '"+jobId+"' -CheckExpiredLegacy } catch {}",
    " if ($actual -cne $expected) { throw ('Unexpected expired-file decision for '+$case.id) }",
    " if ((Get-Content -LiteralPath $manual -Raw) -cne $before) { throw 'Validation changed the file.' }",
    "}",
    "Write-Output 'offline-expired-validation-ok'",
  ].join("\r\n");
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{cwd:directory,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(result.stdout.trim(),"offline-expired-validation-ok");
});

test("Windows directory setup rejects collisions and revalidates protection before changing ACLs",
  {skip:process.platform!=="win32"},async t=>{
  const directory=await temp(t);
  await fs.writeFile(path.join(directory,"generated.ps1"),buildManagedTerminalInstaller({targetSerial,entraDeviceId,jobId}));
  const script=[
    "$ErrorActionPreference='Stop'",
    "$parseErrors=$null",
    "$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'generated.ps1'),[ref]$null,[ref]$parseErrors)",
    "if ($parseErrors.Count) { throw $parseErrors[0].Message }",
    "$names=@('New-TerminalDirectoryAcl','New-TerminalExclusiveDirectory','Initialize-TerminalDirectory')",
    "foreach ($name in $names) {",
    " $fn=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)",
    " if (-not $fn) { throw 'Missing protected directory helper' }",
    " . ([scriptblock]::Create($fn.Extent.Text))",
    "}",
    "$knownExisting=(Get-Location).Path",
    "$sections=[Security.AccessControl.AccessControlSections]::Access",
    "$originalAcl=[IO.Directory]::GetAccessControl($knownExisting,$sections).GetSecurityDescriptorSddlForm($sections)",
    "$collision=$false",
    "try { New-TerminalExclusiveDirectory $knownExisting } catch { $collision=$_.Exception.Message -eq 'A tablet directory appeared during protected installation.' }",
    "if (-not $collision -or [IO.Directory]::GetAccessControl($knownExisting,$sections).GetSecurityDescriptorSddlForm($sections) -cne $originalAcl) { throw 'Native exclusive creation reused an existing path.' }",
    "function Assert-TerminalPath {",
    " param([string]$Path)",
    " $script:checks++",
    " if ($script:mode -eq 'foreign' -or ($script:mode -eq 'redirected-late' -and $script:checks -eq 2)) { throw 'Unsafe path' }",
    " return $Path",
    "}",
    "function Test-Path {",
    " param([string]$LiteralPath,[string]$PathType)",
    " if ($PathType -eq 'Container') { return $script:state -eq 'directory' }",
    " return $script:state -ne 'absent'",
    "}",
    "function New-TerminalExclusiveDirectory {",
    " param([string]$Path)",
    " $script:created++",
    " if ($script:mode -eq 'collision') { throw 'A directory appeared' }",
    " $script:state='directory'",
    "}",
    "function Set-TerminalProtection {",
    " param([string]$Path)",
    " if ($script:checks -ne 2 -or $script:state -ne 'directory') { throw 'ACL update lacks renewed verification' }",
    " $script:hardened++",
    "}",
    "foreach ($case in @(",
    " @{mode='first';state='absent';create=1;harden=1;fail=$false},",
    " @{mode='owned';state='directory';create=0;harden=1;fail=$false},",
    " @{mode='foreign';state='directory';create=0;harden=0;fail=$true},",
    " @{mode='file';state='file';create=0;harden=0;fail=$true},",
    " @{mode='collision';state='absent';create=1;harden=0;fail=$true},",
    " @{mode='redirected-late';state='absent';create=1;harden=0;fail=$true}",
    ")) {",
    " $script:mode=$case.mode;$script:state=$case.state;$script:checks=0;$script:created=0;$script:hardened=0;$failed=$false",
    " try { Initialize-TerminalDirectory (Join-Path (Get-Location) 'mock-target') } catch { $failed=$true }",
    " if ($failed -ne $case.fail -or $script:created -ne $case.create -or $script:hardened -ne $case.harden) { throw ('Unsafe directory setup: '+$case.mode) }",
    "}",
    "Write-Output 'offline-protected-directory-ok'",
  ].join("\r\n");
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{cwd:directory,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(result.stdout.trim(),"offline-protected-directory-ok");
});

async function testDevice(t){
  const folder=await temp(t),identityPath=path.join(folder,"identity.json"),managedPath=path.join(folder,"managed.json");
  const keys=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const publicKeySpki=keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  const signingContexts=[],requests=[],keyAccess=[];
  let now=Date.parse("2026-11-23T12:00:00.000Z"),reply=()=>new Response(JSON.stringify({data:{status:"waiting"}}),{status:202});
  const keyFactory=id=>({
    async publicKey({create=false}={}){keyAccess.push({id,create});return {publicKeySpki};},
    async sign(canonical){
      signingContexts.push(canonical);
      return crypto.sign("sha256",Buffer.from(canonical),{key:keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
    }
  });
  const deviceOptions={identityPath,managedPath,keyFactory,clock:()=>now,fetchImpl:async(url,options)=>{
    assert.equal(url.href,"https://eats.calai.info"+target);
    assert.equal(options.method,"POST");assert.equal(options.redirect,"error");
    assert.equal(options.headers.cookie,undefined);assert.equal(options.headers.authorization,undefined);
    const body=JSON.parse(options.body);
    requests.push(body);
    return reply(body);
  }};
  const verify=(signature,message)=>assert.equal(crypto.verify("sha256",Buffer.from(message),
    {key:keys.publicKey,dsaEncoding:"ieee-p1363"},Buffer.from(signature,"base64url")),true);
  const device=await new TerminalDevice(deviceOptions).load();
  const poll=managedSetupPoller({device,managedPath,clock:()=>now});
  return {device,poll,publicKeySpki,keyAccess,verify,managedPath,identityPath,requests,signingContexts,
    advance:ms=>{now+=ms;},setReply:handler=>{reply=handler;},
    restart:()=>new TerminalDevice(deviceOptions).load()};
}

test("managed evidence proves exact job and public key without pre-activating or persisting secrets",async t=>{
  const f=await testDevice(t);
  assert.equal(f.device.bootstrap().managedSetupPending,undefined);
  const evidence=await f.device.prepareManagedSetup(jobId,f.managedPath);
  const wire=encodeManagedEvidence(evidence);
  assert.match(wire,/^CAL_EATS_MANAGED_SETUP_V1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(wire.split(":")[1],"base64url")),evidence);
  assert.deepEqual(Object.keys(evidence),["jobId","publicKeySpki","signature"]);
  f.verify(evidence.signature,"Cal-Eats managed terminal evidence v1\n"+jobId+"\n"+f.publicKeySpki);
  assert.deepEqual(await readManagedSetup(f.managedPath),{schemaVersion:1,jobId,publicKeySpki:f.publicKeySpki,state:"pending"});
  assert.equal(f.device.bootstrap().paired,false);
  assert.deepEqual(f.requests,[]);
  assert.equal(f.keyAccess[0].create,true);
  await f.device.prepareManagedSetup(jobId,f.managedPath);
  assert.equal(f.keyAccess.at(-1).create,false);
  await assert.rejects(f.device.prepareManagedSetup(otherJob,f.managedPath),{code:"TABLET_MANAGED_SETUP_CONFLICT"});
  assert.equal(requestAllowed("POST",target,null,businessId),false);
  await assert.rejects(f.device.enrol({terminalId:otherJob,code:"synthetic-test-value",deviceName:"manual"}),{code:"TABLET_MANAGED_SETUP_CONFLICT"});
});

test("pending poll backs off, authenticates the challenge and recovers exactly after a lost activation response",async t=>{
  const f=await testDevice(t);
  await f.device.prepareManagedSetup(jobId,f.managedPath);
  await Promise.all([f.poll(),f.poll(),f.poll()]);
  assert.deepEqual(f.requests,[{jobId,publicKeySpki:f.publicKeySpki}]);
  assert.equal(f.device.bootstrap().managedSetupPending,true);
  assert.equal(f.device.identity,null);
  f.advance(29999);await f.poll();assert.equal(f.requests.length,1);
  let lose=true;
  f.setReply(body=>{
    if(!Object.hasOwn(body,"signature"))return Response.json({data:{challenge}});
    assert.deepEqual(Object.keys(body),["jobId","publicKeySpki","challenge","signature"]);
    f.verify(body.signature,"Cal-Eats managed terminal activation v1\n"+jobId+"\n"+challenge+"\n"+f.publicKeySpki);
    if(lose){lose=false;throw new Error("offline fixture dropped acknowledgement");}
    return Response.json({data:{paired:true,terminalId:jobId,businessId,registeredAt:"2026-11-23T12:00:00.000Z"}},{status:201});
  });
  f.advance(1);
  await assert.rejects(f.poll(),{code:"TABLET_NETWORK_UNAVAILABLE"});
  assert.equal((await readManagedSetup(f.managedPath)).state,"pending");
  assert.equal(f.device.identity,null);
  f.advance(30000);await f.poll();
  assert.equal(f.requests.length,5);
  assert.equal(f.device.bootstrap().paired,true);
  assert.equal(f.device.bootstrap().managedSetupPending,undefined);
  assert.equal(await readManagedSetup(f.managedPath),null);
  const identity=JSON.parse(await fs.readFile(f.identityPath,"utf8"));
  assert.equal(identity.terminalId,jobId);assert.equal(identity.businessId,businessId);
  assert.equal(Object.hasOwn(identity,"challenge"),false);assert.equal(Object.hasOwn(identity,"signature"),false);
  const restarted=await f.restart();
  assert.equal(restarted.bootstrap().paired,true);
  assert.equal(restarted.grant,null);
  assert.equal(f.keyAccess.every(entry=>entry.id===jobId),true);
  await assert.rejects(restarted.prepareManagedSetup(otherJob,f.managedPath),{code:"TABLET_LOCAL_REPLACEMENT_REQUIRED"});
});

test("activation refuses malformed proofs and records only an authoritative closed state",async t=>{
  const f=await testDevice(t);
  await f.device.prepareManagedSetup(jobId,f.managedPath);
  f.setReply(()=>Response.json({data:{challenge:"not-fresh"}}));
  await assert.rejects(f.poll(),{code:"TABLET_MANAGED_RESPONSE_INVALID"});
  assert.equal(f.signingContexts.length,1);
  assert.equal((await readManagedSetup(f.managedPath)).state,"pending");
  f.advance(30000);
  f.setReply(()=>Response.json({error:{code:"UNRELATED_GONE"}},{status:410}));
  await assert.rejects(f.poll(),{code:"UNRELATED_GONE"});
  assert.equal((await readManagedSetup(f.managedPath)).state,"pending");
  f.advance(60000);
  f.setReply(()=>Response.json({error:{code:"MANAGED_SETUP_CLOSED"}},{status:410}));
  await assert.rejects(f.poll(),{code:"MANAGED_SETUP_CLOSED"});
  assert.equal((await readManagedSetup(f.managedPath)).state,"closed");
  assert.equal(f.device.bootstrap().managedSetupPending,undefined);
  assert.equal(f.device.identity,null);
  f.advance(300000);await f.poll();assert.equal(f.requests.length,3);
  await assert.rejects(f.device.prepareManagedSetup(jobId,f.managedPath),{code:"MANAGED_SETUP_CLOSED"});
  await f.device.prepareManagedSetup(otherJob,f.managedPath);
  assert.equal((await readManagedSetup(f.managedPath)).jobId,otherJob);
});
