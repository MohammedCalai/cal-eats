import assert from "node:assert/strict";
import test from "node:test";
import {createBusinessBootstrap} from "../src/business-bootstrap.js";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const terminalUser = {id:"terminal-user",role:"restaurant"};
const terminalResult = () => ({principalKind:"terminal",terminalId:"terminal-a",businessId:"business-a",restaurantId:"restaurant-a",user:terminalUser});
const offline = () => Object.assign(Error("Synthetic network unavailable"),{status:503,code:"TABLET_NETWORK_UNAVAILABLE"});
function fixture(overrides={}) {
  let snapshot={status:"offline",paired:true,terminalId:"terminal-a",context:null}, next=0;
  const calls=[],sessions=[],principals=[],timers=new Map();
  const controller=createBusinessBootstrap({
    readHuman:async()=>{calls.push("human");throw Object.assign(Error("No human session"),{status:401});},
    connectTerminal:async()=>{calls.push("connect");snapshot={status:"ready",paired:true,context:terminalResult()};},
    readTerminal:async()=>{calls.push("terminal");return terminalResult();},
    terminalStatus:()=>snapshot,canDiscover:()=>true,
    setPrincipal:value=>principals.push(value),onSession:value=>sessions.push(value),
    schedule:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},cancel:id=>timers.delete(id),...overrides
  });
  return {controller,calls,sessions,principals,timers,setStatus:value=>{snapshot=value;},async next(){const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();await flush();}};
}

test("paired cold start retries a failed cloud read and authenticates only after native signed identity succeeds",async()=>{
  let attempts=0;const f=fixture({connectTerminal:async()=>{if(attempts++===0)throw offline();f.setStatus({status:"ready",paired:true,context:terminalResult()});}});
  await f.controller.refresh();assert.equal(f.sessions.at(-1).user,null);assert.equal([...f.timers.values()][0].delay,5000);
  await f.next();assert.equal(f.sessions.at(-1).user.id,terminalUser.id);assert.equal(f.principals.at(-1),"terminal");assert.equal(f.timers.size,0);
  assert.deepEqual(f.calls,["human","human","terminal"]);f.controller.stop();
});

test("unpaired, revoked and unknown ordinary browsers never enter an automatic bootstrap retry loop",async()=>{
  for(const snapshot of [{status:"unpaired",paired:false},{status:"revoked",paired:true},{status:"not_installed",paired:null}]){
    let connections=0;const f=fixture({connectTerminal:async()=>{connections++;throw offline();}});f.setStatus(snapshot);
    await f.controller.refresh();assert.equal(connections,1);assert.equal(f.timers.size,0);assert.equal(f.principals.includes("terminal"),false);f.controller.stop();
  }
  const phone=fixture({canDiscover:()=>false});await phone.controller.refresh();assert.deepEqual(phone.calls,["human"]);assert.equal(phone.timers.size,0);
});

test("a native connection never replaces a separately authorised owner session or financial role",async()=>{
  const human={id:"owner-a",role:"restaurant"};let attempts=0,changed=0;
  const f=fixture({readHuman:async()=>({user:human}),onTerminal:()=>{changed++;},connectTerminal:async()=>{if(attempts++===0)throw offline();f.setStatus({status:"ready",paired:true,context:terminalResult()});}});
  await f.controller.refresh();assert.equal(f.sessions.at(-1).user,human);assert.equal([...f.timers.values()][0].delay,5000);
  await f.next();assert.equal(changed,1);assert.ok(f.sessions.every(session=>session.user===human));assert.ok(f.principals.every(value=>value==="human"));f.controller.stop();
});

test("explicit logout invalidates an in-flight bootstrap and its late completion cannot sign the tablet in again",async()=>{
  let finish;const f=fixture({connectTerminal:async()=>{await new Promise(resolve=>{finish=resolve;});f.setStatus({status:"ready",paired:true,context:terminalResult()});}});
  const opening=f.controller.refresh();await flush();f.controller.signOut();finish();await opening;
  assert.equal(f.sessions.length,0);assert.equal(f.timers.size,0);
  await f.controller.refresh();assert.equal(f.sessions.at(-1).user,null);assert.equal(f.calls.includes("terminal"),false);
});

test("retry backoff is bounded, does not overlap and stops immediately on revocation",async()=>{
  let attempts=0;const f=fixture({connectTerminal:async()=>{attempts++;throw offline();}});
  await f.controller.refresh();const delays=[];
  for(let i=0;i<5;i++){delays.push([...f.timers.values()][0].delay);await f.next();}
  assert.deepEqual(delays,[5000,10000,30000,60000,60000]);assert.equal(attempts,6);
  f.setStatus({status:"revoked",paired:true});await f.next();assert.equal(f.timers.size,0);f.controller.stop();
});

test("a mismatched signed identity or denial cannot grant a session or trigger permissive retries",async()=>{
  const mismatch=fixture({readTerminal:async()=>({...terminalResult(),businessId:"other"})});
  await mismatch.controller.refresh();assert.equal(mismatch.sessions.at(-1).user,null);assert.equal(mismatch.principals.includes("terminal"),false);assert.equal(mismatch.timers.size,0);
  const denied=fixture({connectTerminal:async()=>{throw Object.assign(Error("Revoked"),{status:403,code:"TERMINAL_REVOKED"});}});
  await denied.controller.refresh();assert.equal(denied.timers.size,0);
});

test("Strict Mode or repeated refresh settles an aborted read before starting the next generation",async()=>{
  let reads=0,active=0,max=0;const f=fixture({canDiscover:()=>false,readHuman:({signal})=>{reads++;active++;max=Math.max(max,active);return new Promise((resolve,reject)=>{signal.addEventListener("abort",()=>{active--;reject(Error("aborted"));},{once:true});if(reads===2){active--;resolve({user:{id:"current-owner"}});}});}});
  const first=f.controller.refresh();await flush();const second=f.controller.refresh();await Promise.all([first,second]);
  assert.equal(max,1);assert.equal(f.sessions.length,1);assert.equal(f.sessions[0].user.id,"current-owner");f.controller.stop();
});

test("only a successful explicit human sign-in can release the same-page logout latch",async()=>{
  let human=null;const verified=[];const f=fixture({readHuman:async()=>{if(human)return{user:human};throw Error("Signed out");},onTerminal:state=>verified.push(state)});
  f.controller.signOut();await f.controller.refresh({afterSignIn:true});assert.equal(f.calls.includes("connect"),false);
  human={id:"owner-a",role:"restaurant"};await f.controller.refresh({afterSignIn:true});assert.equal(f.calls.filter(value=>value==="connect").length,1);
  assert.equal(verified.length,1);assert.equal(verified[0].afterSignIn,true);assert.equal(verified[0].terminalContext.principalKind,"terminal");
  assert.ok(f.sessions.filter(value=>value.user).every(value=>value.user===human));f.controller.stop();
});
