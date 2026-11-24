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
