import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import {EventEmitter} from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {TerminalDevice,readManagedSetup} from "../src/device.js";
import {managedSetupPoller} from "../src/index.js";
import {encodeManagedEvidence,requestAllowed} from "../src/protocol.js";
import {runWindowsKeyHelper,WindowsDeviceKey} from "../src/windows-key.js";
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

test("managed delivery revisions produce distinct deterministic scripts without replacing the broker payload",()=>{
  const options={targetSerial,entraDeviceId,jobId};
  const original=buildManagedTerminalInstaller(options);
  assert.equal(buildManagedTerminalInstaller({...options,deliveryRevision:1}),original);
  const second=buildManagedTerminalInstaller({...options,deliveryRevision:2});
  const third=buildManagedTerminalInstaller({...options,deliveryRevision:3});
  assert.notEqual(second,original);assert.notEqual(second,third);
  assert.equal(buildManagedTerminalInstaller({...options,deliveryRevision:2}),second);
  const decode=script=>JSON.parse(Buffer.from(/\$TerminalManagedSetupBase64='([A-Za-z0-9+/=]+)'/.exec(script)[1],"base64"));
  const payload=script=>/\$TerminalPayload=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)[1];
  assert.deepEqual(decode(second),{jobId,entraDeviceId,deliveryRevision:2});
  assert.deepEqual(decode(third),{jobId,entraDeviceId,deliveryRevision:3});
  assert.equal(payload(original),payload(second));
  assert.equal(payload(second),payload(third));
  for(const deliveryRevision of [0,-1,2.5,"2",null,undefined,Infinity,2**53]) {
    assert.throws(()=>buildManagedTerminalInstaller({...options,deliveryRevision}),/Invalid managed tablet setup/);
  }
  const getter=Object.defineProperty({...options},"deliveryRevision",{get(){throw Error("Unexpected getter");}});
  assert.throws(()=>buildManagedTerminalInstaller(getter),/Invalid managed tablet setup/);
});

test("Windows PowerShell 5.1 checks delivery revision before building native arguments",
  {skip:process.platform!=="win32"},async t=>{
  const directory=await temp(t);
  const options={targetSerial,entraDeviceId,jobId};
  await fs.writeFile(path.join(directory,"generated.ps1"),buildManagedTerminalInstaller({...options,deliveryRevision:2}));
  await fs.writeFile(path.join(directory,"cases.json"),JSON.stringify([
    {setup:{jobId,entraDeviceId},expected:1},
    {setup:{jobId,entraDeviceId,deliveryRevision:2},expected:2},
    {setup:{jobId,entraDeviceId,deliveryRevision:Number.MAX_SAFE_INTEGER},expected:Number.MAX_SAFE_INTEGER},
    ...[0,1,2.5,"2",null,2**53].map(deliveryRevision=>({setup:{jobId,entraDeviceId,deliveryRevision},expected:null})),
    {setup:{jobId,entraDeviceId,DeliveryRevision:2},expected:null},
    {setup:{jobId,entraDeviceId,deliveryRevision:2,extra:true},expected:null},
  ]));
  const runner=[
    "$ErrorActionPreference='Stop'",
    "$parseErrors=$null",
    "$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'generated.ps1'),[ref]$null,[ref]$parseErrors)",
    "if ($parseErrors.Count) { throw $parseErrors[0].Message }",
    "$fn=$tree.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-TerminalManagedSetupRevision'},$true)",
    "if (-not $fn) { throw 'Missing delivery revision check' }",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "$ManagedUuid='\\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\z'",
    "$cases=Get-Content -LiteralPath 'cases.json' -Raw -Encoding UTF8 | ConvertFrom-Json",
    "foreach ($case in $cases) {",
    " $actual=$null",
    " try { $actual=Get-TerminalManagedSetupRevision $case.setup } catch {}",
    " if ($actual -cne $case.expected) { throw 'Unexpected delivery revision decision' }",
    "}",
    "$argsNode=$tree.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$EvidenceArguments'},$true)",
    "$revisionNode=$tree.Find({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($TerminalManagedDeliveryRevision -gt 1)')},$true)",
    "$TerminalConfig='C:\\Synthetic Tablet\\config.json';$TerminalManagedSetup=$cases[0].setup",
    "foreach ($TerminalManagedDeliveryRevision in @(1,2)) {",
    " . ([scriptblock]::Create($argsNode.Extent.Text));. ([scriptblock]::Create($revisionNode.Extent.Text))",
    " $expectedCount=if ($TerminalManagedDeliveryRevision -eq 1) {4} else {5}",
    " if ($EvidenceArguments.Count -ne $expectedCount -or $EvidenceArguments[3] -cne $TerminalManagedSetup.jobId -or ($expectedCount -eq 5 -and $EvidenceArguments[4] -cne '2')) { throw 'Unexpected managed installer arguments' }",
    "}",
    "Write-Output 'offline-delivery-revision-ok'",
  ].join("\r\n");
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",runner],{cwd:directory,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(result.stdout.trim(),"offline-delivery-revision-ok");
});

test("the managed CLI returns a typed failure and suppresses raw configuration errors",async t=>{
  const directory=await temp(t);
  const config=path.join(directory,"private-config-name.json");
  await fs.writeFile(config,"invalid private configuration contents");
  const entry=fileURLToPath(new URL("../src/index.js",import.meta.url));
  const result=spawnSync(process.execPath,[entry,"--config",config,"--prepare-managed",jobId],{encoding:"utf8",timeout:10000});
  assert.equal(result.status,1);
  assert.equal(result.stdout,"");
  assert.equal(result.stderr.trim(),"CAL_EATS_MANAGED_SETUP_ERROR_V1:TABLET_MANAGED_CONFIG:00000000");
});

test("key helper preserves one bounded diagnostic and discards other native errors",async()=>{
  const invoke=stderr=>runWindowsKeyHelper({},{platform:"win32",spawnImpl(){
    const child=Object.assign(new EventEmitter(),{
      stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),
    });
    queueMicrotask(()=>{
      for(const chunk of stderr)child.stderr.write(Buffer.from(chunk));
      child.stderr.end();
      child.emit("close",1);
    });
    return child;
  }});
  const marker="CAL_EATS_TERMINAL_KEY_V1:TABLET_KEY_ACL_SET:80090010";
  await assert.rejects(invoke([marker.slice(0,23),marker.slice(23),"\r\n"]),{
    code:"TABLET_KEY_ACL_SET",windowsStatus:"80090010",
  });
  for(const stderr of [["private path or data"],[marker,"\n",marker],[marker,"\n\n"],["x".repeat(4097),marker]]){
    await assert.rejects(invoke(stderr),{
      code:"TABLET_KEY_HELPER_EXIT",windowsStatus:"00000000",message:"Tablet identity could not be used",
    });
  }
});

test("Windows PowerShell 5.1 reports only typed native setup errors and emits one valid proof",
  {skip:process.platform!=="win32"},async t=>{
  const directory=await temp(t);
  const entry=path.join(directory,"test process with spaces.cjs");
  await fs.writeFile(path.join(directory,"generated.ps1"),buildManagedTerminalInstaller({jobId,entraDeviceId,targetSerial}));
  await fs.writeFile(entry,[
    'const [, , mode, value]=process.argv;',
    'if(mode==="ok"&&value==="path with spaces"){process.stdout.write("CAL_EATS_MANAGED_SETUP_V1:fixture-proof\\n");}',
    'else if(mode==="known"){process.stderr.write("CAL_EATS_MANAGED_SETUP_ERROR_V1:TABLET_KEY_ACL_READ:80090010\\n");process.exitCode=1;}',
    'else if(mode==="raw"){process.stderr.write("sensitive native message\\n");process.exitCode=5;}',
    'else{process.stdout.write("sensitive invalid proof\\n");}',
  ].join("\n"));
  const runner=[
    "param([string]$Node,[string]$Entry)",
    "$ErrorActionPreference='Stop'",
    "$parseErrors=$null",
    "$tree=[Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'generated.ps1'),[ref]$null,[ref]$parseErrors)",
    "if ($parseErrors.Count) { throw $parseErrors[0].Message }",
    "$fn=$tree.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-TerminalManagedEvidence'},$true)",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "Read-TerminalManagedEvidence $Node $Entry @('ok','path with spaces')",
    "foreach ($mode in @('known','raw','invalid')) {",
    " try { Read-TerminalManagedEvidence $Node $Entry @($mode) } catch { Write-Output $_.Exception.Message }",
    "}",
  ].join("\r\n");
  await fs.writeFile(path.join(directory,"fixture.ps1"),runner);
  const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File","fixture.ps1",process.execPath,entry],
    {cwd:directory,encoding:"utf8",timeout:15000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout||String(result.error));
  assert.equal(result.stderr,"");
  assert.deepEqual(result.stdout.trim().split(/\r?\n/),[
    "CAL_EATS_MANAGED_SETUP_V1:fixture-proof",
    "The protected tablet key could not prepare managed setup evidence (TABLET_KEY_ACL_READ, Windows status 80090010).",
    "The protected tablet key could not prepare managed setup evidence (TABLET_MANAGED_NODE_EXIT, status 5).",
    "The protected tablet key could not prepare managed setup evidence (TABLET_MANAGED_EVIDENCE_OUTPUT).",
  ]);
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
    async publicKey({create=false,managedSetup=false}={}){keyAccess.push({id,create,managedSetup});return {publicKeySpki};},
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

test("reissued delivery evidence binds revision and reuses the same protected pending job and key",async t=>{
  const f=await testDevice(t);
  const first=await f.device.prepareManagedSetup(jobId,f.managedPath);
  const original=await fs.readFile(f.managedPath,"utf8");
  const second=await f.device.prepareManagedSetup(jobId,f.managedPath,2);
  assert.deepEqual(Object.keys(second),["jobId","deliveryRevision","publicKeySpki","signature"]);
  assert.equal(second.publicKeySpki,first.publicKeySpki);
  const prefix="CAL_EATS_MANAGED_SETUP_V1:";
  const line=encodeManagedEvidence(second);
  assert.ok(line.startsWith(prefix));
  assert.deepEqual(JSON.parse(Buffer.from(line.slice(prefix.length),"base64url")),second);
  f.verify(second.signature,"Cal-Eats managed terminal evidence v2\n"+jobId+"\n2\n"+f.publicKeySpki);
  assert.throws(()=>f.verify(second.signature,"Cal-Eats managed terminal evidence v2\n"+jobId+"\n3\n"+f.publicKeySpki));
  assert.throws(()=>f.verify(second.signature,"Cal-Eats managed terminal evidence v1\n"+jobId+"\n"+f.publicKeySpki));
  assert.equal(await fs.readFile(f.managedPath,"utf8"),original);
  assert.deepEqual(f.keyAccess,[{id:jobId,create:true,managedSetup:true},{id:jobId,create:false,managedSetup:true}]);
  await assert.rejects(f.device.prepareManagedSetup(jobId,f.managedPath,2.1),{code:"TABLET_MANAGED_SETUP_INVALID"});
  await f.poll();
  assert.deepEqual(f.requests,[{jobId,publicKeySpki:f.publicKeySpki}]);
});

test("Windows key adapter selects new managed creation explicitly and signs only supported contexts",async()=>{
  const keys=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const publicKeySpki=keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
  let calls=0;
  const key=new WindowsDeviceKey(jobId,{helper:async input=>{
    calls++;
    assert.equal(input.terminalId,jobId);
    assert.equal(input.provider,"software");
    if(input.action!=="sign")return {publicKeySpki,machineKey:true,nonExportable:true,aclVerified:true,
      provider:"Microsoft Software Key Storage Provider",action:input.action};
    const signature=crypto.sign("sha256",Buffer.from(input.messageBase64,"base64"),
      {key:keys.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
    return {publicKeySpki,signature,machineKey:true,nonExportable:true,aclVerified:true,
      provider:"Microsoft Software Key Storage Provider"};
  }});
  assert.equal((await key.publicKey({create:true,managedSetup:true})).action,"create-managed");
  assert.equal((await key.publicKey({create:false,managedSetup:true})).action,"public");
  assert.equal((await key.publicKey({create:true})).action,"create");
  assert.match(await key.sign("Cal-Eats managed terminal evidence v2\n"+jobId+"\n2\n"+publicKeySpki),/^[A-Za-z0-9_-]{86}$/);
  await assert.rejects(key.sign("Cal-Eats managed terminal activation v2\n"+jobId+"\n"+challenge+"\n"+publicKeySpki),/Unsupported tablet signing context/);
  assert.equal(calls,4);
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
