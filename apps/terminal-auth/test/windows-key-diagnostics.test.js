import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const helper=fileURLToPath(new URL("../windows/terminal-key.ps1",import.meta.url));
const powershell=path.join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
const commonArgs=["-NoLogo","-NoProfile","-NonInteractive"];

function runHelper(input){
  const result=spawnSync(powershell,[...commonArgs,"-ExecutionPolicy","Bypass","-File",helper],{
    input,encoding:"utf8",timeout:10000,windowsHide:true
  });
  assert.ifError(result.error);
  assert.equal(result.status,1);
  assert.equal(result.stdout,"");
  return result.stderr;
}

test("Windows key request failures return one fixed diagnostic without input content",{skip:process.platform!=="win32"},()=>{
  assert.match(runHelper("not JSON: private-audit-marker"),
    /^CAL_EATS_TERMINAL_KEY_V1:TABLET_KEY_REQUEST:[A-F0-9]{8}\r?\n$/);
  assert.match(runHelper('{"terminalId":"private-audit-marker"}'),
    /^CAL_EATS_TERMINAL_KEY_V1:TABLET_KEY_REQUEST:00000000\r?\n$/);
});

test("Windows key requests from a non-SYSTEM caller stop at the auth guard",{skip:process.platform!=="win32"},t=>{
  const identity=spawnSync(powershell,[...commonArgs,"-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],{encoding:"utf8",timeout:10000,windowsHide:true});
  assert.ifError(identity.error);
  assert.equal(identity.status,0);
  if(identity.stdout.trim()==="S-1-5-18"){t.skip("Run as a non-SYSTEM caller to check this guard");return;}

  assert.match(runHelper('{"terminalId":"11111111-1111-4111-8111-111111111111","action":"public","provider":"software"}'),
    /^CAL_EATS_TERMINAL_KEY_V1:TABLET_KEY_AUTH:00000000\r?\n$/);
});

test("unavailable TPM is optional only for new managed software keys", {skip:process.platform!=="win32"},()=>{
  const check=[
    "$ErrorActionPreference='Stop'",
    "$errors=$null;$tree=[Management.Automation.Language.Parser]::ParseFile($env:CAL_EATS_TEST_KEY_HELPER,[ref]$null,[ref]$errors)",
    "if ($errors.Count) { throw $errors[0].Message }",
    "$fn=$tree.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-TerminalAlternateKey'},$true)",
    ". ([scriptblock]::Create($fn.Extent.Text))",
    "$notReady=[Security.Cryptography.CryptographicException]::new(-2146893776)",
    "$wrapped=[Management.Automation.MethodInvocationException]::new('wrapped',$notReady)",
    "$denied=[Security.Cryptography.CryptographicException]::new(-2146893808)",
    "$unexpectedType=[Runtime.InteropServices.ExternalException]::new('not a CNG error',-2146893776)",
    "if (Test-TerminalAlternateKey {throw $wrapped} $true) { throw 'Unready optional TPM must return false' }",
    "if (-not (Test-TerminalAlternateKey {$true} $true)) { throw 'Existing alternate key must still be reported' }",
    "if (Test-TerminalAlternateKey {$false} $false) { throw 'Missing alternate key must return false' }",
    "foreach ($case in @(@{Error=$wrapped;New=$false},@{Error=$denied;New=$true},@{Error=$unexpectedType;New=$true})) {",
    " $reported=$null;try { Test-TerminalAlternateKey {throw $case.Error} $case.New | Out-Null } catch { $reported=$_.Exception.GetBaseException() }",
    " if ($null -eq $reported -or $reported.HResult -ne $case.Error.GetBaseException().HResult) { throw 'Original provider error must be preserved' }",
    "}",
  ].join("\r\n");
  const result=spawnSync(powershell,[...commonArgs,"-Command",check],{
    env:{...process.env,CAL_EATS_TEST_KEY_HELPER:helper},encoding:"utf8",timeout:15000,windowsHide:true,
  });
  assert.ifError(result.error);
  assert.equal(result.status,0,result.stderr);
});
