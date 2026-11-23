import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildTerminalInstaller} from '../windows/build-installer.mjs';

// Synthetic issuer-shaped data only. No real setup, device or account is used.
const SERIAL = 'OFFLINE-TEST-SURFACE-1';
const BUSINESS = '11111111-1111-4111-8111-111111111111';
const TERMINAL = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://eats.calai.info';
const encode = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
const setupAt = (now = Date.now(), extra = {}) => ({
  schemaVersion: 1, product: 'calai-business-terminal', apiBaseUrl: ORIGIN,
  businessId: BUSINESS, terminalId: TERMINAL, code: 'OFFLINE_ONLY_'.padEnd(32, 'a'),
  challenge: 'OFFLINE_ONLY_'.padEnd(43, 'b'), expiresAt: new Date(now + 300_000).toISOString(),
  ...extra,
});
function embedded(script, variable) {
  const match = new RegExp(`\\$${variable}='([A-Za-z0-9+/=]*)'`).exec(script);
  assert.ok(match, `missing data-only ${variable}`);
  return match[1];
}
function assets(script) {
  const match = /\$TerminalPayload=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script);
  assert.ok(match, 'the protected broker payload remains identifiable');
  const bytes = Buffer.from(match[1], 'base64');
  assert.ok(script.includes(createHash('sha256').update(bytes).digest('hex')));
  return JSON.parse(gunzipSync(bytes));
}
function withTemporaryDirectory(work) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(path.join(root, 'caleats-enrolment-offline-'));
  try { return work(directory); }
  finally {
    // Verify the exact resolved throwaway target before recursive cleanup.
    const resolved = realpathSync(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('caleats-enrolment-offline-'));
    rmSync(resolved, {recursive: true, force: true});
  }
}
function powershell(script, directory) {
  const harness = path.join(directory, 'OFFLINE-pure-validation.ps1');
  writeFileSync(harness, script, 'utf8');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness],
  {cwd: directory, encoding: 'utf8', timeout: 25_000, windowsHide: true});
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}

test('one-file enrolment is serial-bound data and preserves the exact issuer document', () => {
  const enrolment = setupAt();
  const script = buildTerminalInstaller({targetSerial: SERIAL, enrolment});
  assert.deepEqual(JSON.parse(Buffer.from(embedded(script, 'TerminalEmbeddedEnrolmentBase64'), 'base64').toString('utf8')), enrolment);
  assert.ok(script.includes(`$TerminalBoundSerial='${SERIAL}'`));
});

test('embedded setup and optional tablet name cannot inject PowerShell source', () => {
  const enrolment = setupAt();
  const deviceName = "OFFLINE '); $(throw 'INJECTION_FIXTURE'); # tablet";
  const script = buildTerminalInstaller({targetSerial: SERIAL, enrolment, deviceName});
  assert.deepEqual(JSON.parse(Buffer.from(embedded(script, 'TerminalEmbeddedEnrolmentBase64'), 'base64').toString('utf8')), enrolment);
  assert.equal(JSON.parse(Buffer.from(embedded(script, 'TerminalEmbeddedDeviceNameBase64'), 'base64').toString('utf8')), deviceName);
  assert.ok(script.includes(`$TerminalBoundSerial='${SERIAL}'`));
  assert.equal(script.includes(enrolment.code), false);
  assert.equal(script.includes(enrolment.challenge), false);
  assert.equal(script.includes('INJECTION_FIXTURE'), false);
  assert.equal(script.includes('__ENROLMENT_BASE64__'), false);
  assert.equal(script.includes('__DEVICE_NAME_BASE64__'), false);
});

test('builder refuses unbound, invalid, expired or overlong embedded authority', () => {
  const now = Date.now();
  const valid = setupAt(now);
  for (const options of [{enrolment: valid}, {targetSerial: '', enrolment: valid}, {targetSerial: SERIAL, enrolment: []},
    ...[null, 0, '1', 2].map(schemaVersion => ({targetSerial: SERIAL, enrolment: {...valid, schemaVersion}})),
    ...[{product: 'other-product'}, {apiBaseUrl: 'https://attacker.invalid'}, {apiBaseUrl: `${ORIGIN}/`},
      {apiBaseUrl: `https://user:password@eats.calai.info`}, {apiBaseUrl: `${ORIGIN}:8443`},
      {terminalId: '00000000-0000-0000-0000-000000000000'}, {businessId: 'not-a-uuid'},
      {code: 'x'.repeat(31)}, {challenge: 'x'.repeat(44)}, {code: "';throw 'INJECTION'"},
      {expiresAt: new Date(now - 1).toISOString()}, {expiresAt: new Date(now + 3_600_000).toISOString()},
      {expiresAt: 'not-a-date'}, {unexpectedSecret: 'OFFLINE-MUST-NOT-EMBED'}]
      .map(change => ({targetSerial: SERIAL, enrolment: {...valid, ...change}}))]) {
    assert.throws(() => buildTerminalInstaller(options));
  }
  for (const deviceName of ['', 'x', 'x'.repeat(81), 'OFFLINE\nname', 'OFFLINE\0name', 42]) {
    assert.throws(() => buildTerminalInstaller({targetSerial: SERIAL, enrolment: valid, deviceName}));
  }
});

test('legacy installers keep optional serial, separate-file setup and identical authenticated broker assets', () => {
  const owner = buildTerminalInstaller();
  const serialOnly = buildTerminalInstaller({targetSerial: SERIAL});
  const oneFile = buildTerminalInstaller({targetSerial: SERIAL, enrolment: setupAt()});
  assert.equal(embedded(owner, 'TerminalEmbeddedEnrolmentBase64'), '');
  assert.equal(embedded(serialOnly, 'TerminalEmbeddedEnrolmentBase64'), '');
  assert.ok(owner.includes("$TerminalBoundSerial=''"));
  assert.match(owner, /\[string\]\$EnrolmentPath=''/);
  assert.match(owner, /\[switch\]\$ForgetRegistration/);
  const originalAssets = assets(owner);
  assert.deepEqual(assets(serialOnly), originalAssets);
  assert.deepEqual(assets(oneFile), originalAssets, 'packaging setup cannot substitute weaker broker/key code');
  assert.deepEqual(originalAssets.files.map(file => file.name), [
    'package.json', 'src/protocol.js', 'src/windows-key.js', 'src/device.js', 'src/broker.js', 'src/index.js', 'windows/terminal-key.ps1',
  ]);
  for (const file of originalAssets.files) {
    assert.equal(createHash('sha256').update(Buffer.from(file.bytes, 'base64')).digest('hex'), file.sha256);
  }
});

test('Windows PowerShell 5.1 parses and isolates enrolment validation before any installation write',
  {skip: process.platform !== 'win32'}, () => withTemporaryDirectory(directory => {
    const installer = path.join(directory, 'OFFLINE-generated-installer.ps1');
    writeFileSync(installer, buildTerminalInstaller({targetSerial: SERIAL, enrolment: setupAt()}));
    const now = Date.now();
    const valid = setupAt(now);
    const legacy = {...valid}; delete legacy.schemaVersion; delete legacy.product;
    const identity = extra => ({schemaVersion: 1, product: 'calai-business-terminal', terminalId: TERMINAL,
      businessId: BUSINESS, paired: true, ...extra});
    const cases = [
      {name: 'valid embedded issuer setup', setup: valid, embedded: true, accepted: true},
      {name: 'legacy six-field file', setup: legacy, embedded: false, accepted: true},
      ...[[valid], [valid, valid], null, true, 1, 'OFFLINE-NOT-AN-OBJECT']
        .map(setup => ({name: `wrong JSON shape ${JSON.stringify(setup).slice(0, 14)}`, setup, embedded: true, accepted: false})),
      {name: 'invalid base64 is rejected', encoded: '!!!!', embedded: true, accepted: false},
      {name: 'invalid UTF8 is rejected', encoded: Buffer.from([0xc3, 0x28]).toString('base64'), embedded: true, accepted: false},
      {name: 'invalid JSON is rejected', encoded: Buffer.from('{OFFLINE-MALFORMED').toString('base64'), embedded: true, accepted: false},
      ...[{schemaVersion: 2}, {product: 'other-product'}, {apiBaseUrl: 'https://attacker.invalid'},
        {terminalId: OTHER, businessId: 'bad'}, {code: 'short'}, {challenge: 'short'},
        {expiresAt: new Date(now - 1).toISOString()}, {expiresAt: new Date(now + 3_600_000).toISOString()},
        {expiresAt: 'bad'}, {unexpectedSecret: 'OFFLINE-UNEXPECTED'}]
        .map(change => ({name: `invalid embedded ${Object.keys(change).join(',')}`, setup: {...valid, ...change}, embedded: true, accepted: false})),
      {name: 'different existing terminal', setup: valid, embedded: true, identity: identity({terminalId: OTHER}), accepted: false},
      {name: 'different existing business', setup: valid, embedded: true, identity: identity({businessId: OTHER}), accepted: false},
      {name: 'same existing terminal', setup: valid, embedded: true, identity: identity({}), accepted: true},
      {name: 'embedded cannot forget identity', setup: valid, embedded: true, forget: true, identity: identity({terminalId: OTHER}), accepted: false},
      {name: 'legacy explicit replacement', setup: legacy, embedded: false, forget: true, identity: identity({terminalId: OTHER}), accepted: true},
    ];
    const input = encode({now: new Date(now).toISOString(), cases: cases.map(value => ({...value,
      encoded: value.encoded ?? encode(value.setup)}))});
    const escaped = installer.replaceAll("'", "''");
    const report = powershell(`
$ErrorActionPreference='Stop'
Set-StrictMode -Version 2.0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)
if(@($errors).Count){throw 'Generated installer does not parse.'}
$names=@('ConvertFrom-TerminalSetupData','Assert-TerminalEnrolmentData','Assert-TerminalSetupIdentity')
foreach($name in $names){
 $functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true))
 if($functions.Count -ne 1){throw 'Missing pure setup validator.'}
 $commands=@($functions[0].FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)|ForEach-Object{$_.GetCommandName()})
 if(@($commands|Where-Object{$_ -match '^(?:New-Item|Set-|Remove-|Move-|Copy-|Register-|Unregister-|Start-|Stop-|Get-Cim|Get-Local|Invoke-Web|Invoke-Rest)' }).Count){throw 'Setup validation contains an install/device command.'}
 if($functions[0].Extent.Text -match '::(?:WriteAll|AppendAll|Delete|CreateDirectory)'){throw 'Setup validation contains a filesystem write.'}
 . ([scriptblock]::Create($functions[0].Extent.Text))
}
function Test-WithinFunction($Node){$parent=$Node.Parent;while($parent){if($parent -is [Management.Automation.Language.FunctionDefinitionAst]){return $true};$parent=$parent.Parent};return $false}
$calls=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)|Where-Object{-not (Test-WithinFunction $_)})
$write=@($calls|Where-Object{$_.GetCommandName() -in @('New-Item','Set-Acl','Move-Item','Copy-Item','Stop-ScheduledTask','Register-ScheduledTask','Start-ScheduledTask')}|Sort-Object {$_.Extent.StartOffset})[0].Extent.StartOffset
foreach($name in @('Assert-TerminalEnrolmentData','Assert-TerminalSetupIdentity')){
 $validation=@($calls|Where-Object{$_.GetCommandName() -ceq $name})
 if($validation.Count -lt 1 -or @($validation|Where-Object{$_.Extent.StartOffset -lt $write}).Count -lt 1){throw 'Setup validation is ordered after an installation write.'}
}
$text=$ast.Extent.Text
if($text.IndexOf('$TerminalExpectedSerial=') -ge $write){throw 'Serial binding is ordered after installation.'}
$script:mutations=0
function New-Item{$script:mutations++;throw 'Write trap'}
function Set-Acl{$script:mutations++;throw 'Write trap'}
function Register-ScheduledTask{$script:mutations++;throw 'Write trap'}
function Start-ScheduledTask{$script:mutations++;throw 'Write trap'}
function Stop-ScheduledTask{$script:mutations++;throw 'Write trap'}
function Move-Item{$script:mutations++;throw 'Write trap'}
function Remove-Item{$script:mutations++;throw 'Write trap'}
function Get-CimInstance{[pscustomobject]@{SerialNumber='OFFLINE-WRONG-SURFACE'}}
function Get-LocalUser{throw 'Device read trap'}
$guards=New-Object 'System.Collections.Generic.List[object]'
$serialGuard=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($TerminalExpectedSerial -and ')},$true))
if($serialGuard.Count -ne 1 -or $serialGuard[0].Extent.StartOffset -ge $write){throw 'Wrong-device guard missing before writes.'}
$TerminalExpectedSerial='${SERIAL}';$rejected=$false
try{& ([scriptblock]::Create($serialGuard[0].Extent.Text))}catch{$rejected=$true}
$guards.Add([pscustomobject]@{Name='wrong serial rejects using fixture BIOS read only';Rejected=$rejected})
$combinedGuard=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($TerminalHasEmbeddedEnrolment -and ')},$true))
if($combinedGuard.Count -ne 1 -or $combinedGuard[0].Extent.StartOffset -ge $write){throw 'Ambiguous-input guard missing before writes.'}
$TerminalHasEmbeddedEnrolment=$true;$TerminalBoundSerial='${SERIAL}'
foreach($variant in @('file','forget','unbound')){
 $EnrolmentPath='';$ForgetRegistration=$false;$TerminalBoundSerial='${SERIAL}'
 if($variant -eq 'file'){$EnrolmentPath='OFFLINE-UNREAD-FILE.json'}
 if($variant -eq 'forget'){$ForgetRegistration=$true}
 if($variant -eq 'unbound'){$TerminalBoundSerial=''}
 $rejected=$false;try{& ([scriptblock]::Create($combinedGuard[0].Extent.Text))}catch{$rejected=$true}
 $guards.Add([pscustomobject]@{Name=('embedded guard '+$variant);Rejected=$rejected})
}
$inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json
$results=New-Object 'System.Collections.Generic.List[object]'
foreach($case in $inputData.cases){
 $accepted=$false
 try{
  $setup=ConvertFrom-TerminalSetupData -Encoded $case.encoded
  Assert-TerminalEnrolmentData -Setup $setup -Embedded:([bool]$case.embedded) -Now ([DateTimeOffset]::Parse($inputData.now))
  $identity=$null;if($case.PSObject.Properties['identity']){$identity=$case.identity}
  $forget=$false;if($case.PSObject.Properties['forget']){$forget=[bool]$case.forget}
  Assert-TerminalSetupIdentity -Setup $setup -SavedIdentity $identity -Embedded:([bool]$case.embedded) -ForgetRegistration:$forget
  $accepted=$true
 }catch{}
 $results.Add([pscustomobject]@{Name=$case.name;Accepted=$accepted;Expected=[bool]$case.accepted})
}
$projection=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$SetupOutput'},$true))
if($projection.Count -ne 1 -or @($projection[0].FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)).Count){throw 'Expected a pure broker enrolment projection.'}
$TerminalSetup=ConvertFrom-TerminalSetupData -Encoded $inputData.cases[0].encoded
. ([scriptblock]::Create($projection[0].Extent.Text))
[pscustomobject]@{Version=$PSVersionTable.PSVersion.ToString();Results=$results.ToArray();Guards=$guards.ToArray();BrokerSetupKeys=@($SetupOutput.Keys|Sort-Object);MutationCalls=$script:mutations;InstallerEntryPointExecuted=$false}|ConvertTo-Json -Depth 8 -Compress
`, directory);
    assert.match(report.Version, /^5\.1\./);
    assert.equal(report.MutationCalls, 0);
    assert.equal(report.InstallerEntryPointExecuted, false);
    assert.deepEqual(report.BrokerSetupKeys, ['apiBaseUrl', 'businessId', 'challenge', 'code', 'expiresAt', 'terminalId']);
    for (const guard of report.Guards) assert.equal(guard.Rejected, true, guard.Name);
    for (const result of report.Results) assert.equal(result.Accepted, result.Expected, result.Name);
  }));
