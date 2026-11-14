import test from "node:test";
import assert from "node:assert/strict";
import {createBusinessMessageMelody} from "../src/business-message-melody.js";

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function clock(){
  let now=0,id=0;const pending=new Map();
  return {
    setTimeout(fn,delay){const key=++id;pending.set(key,{fn,at:now+delay});return key;},
    clearTimeout(key){pending.delete(key);},
    advance(duration){now+=duration;for(const [key,row] of [...pending])if(row.at<=now){pending.delete(key);row.fn();}},
    count:()=>pending.size
  };
}
function fixture(){
  const notes=[],gains=[],contexts=[],timers=clock();
  class Context{
    currentTime=0;state="suspended";destination={};resumeCalls=0;closeCalls=0;
    constructor(){contexts.push(this);}
    resume(){this.resumeCalls++;return new Promise((resolve,reject)=>{this.resumeResolve=resolve;this.resumeReject=reject;});}
    releaseResume(){if(this.state!=="closed")this.state="running";this.resumeResolve();}
    createOscillator(){const note={frequency:{},connect(){return this;},disconnect(){this.disconnected=true;},start(at){this.startAt=at;},stop(at){if(at===undefined)this.stopped=true;else this.endAt=at;}};notes.push(note);return note;}
    createGain(){const ramps=[],node={ramps,gain:{setValueAtTime(){},exponentialRampToValueAtTime(value){ramps.push(value);}},connect(){return this;},disconnect(){this.disconnected=true;}};gains.push(node);return node;}
    close(){this.closeCalls++;this.state="closed";return Promise.resolve();}
  }
  return {player:createBusinessMessageMelody(()=>Context,timers),Context,contexts,notes,gains,timers};
}

test("preparing is silent and the original three-note chime completes in less than a second",async()=>{
  const f=fixture(),warm=f.player.prepare();
  assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].resumeCalls,1);assert.equal(f.notes.length,0);
  f.contexts[0].releaseResume();await warm;
  assert.equal(f.timers.count(),0);assert.equal(f.notes.length,0);
  const work=f.player.play();await flush();
  assert.deepEqual(f.notes.map(note=>note.frequency.value),[523.25,659.25,783.99]);
  assert.ok(Math.max(...f.notes.map(note=>note.endAt))<1);
  assert.ok(f.gains.every(gain=>Math.max(...gain.ramps)===.14));
  f.notes[2].onended();await work;
  assert.ok(f.notes.every(note=>note.onended===null&&note.stopped&&note.disconnected));
  assert.ok(f.gains.every(gain=>gain.disconnected));f.player.dispose();
});

test("pause settles permission-waiting playback immediately and a later resume stays silent",async()=>{
  const f=fixture();let finished=false;
  const work=f.player.play().then(()=>{finished=true;});f.player.pause();await work;
  assert.equal(finished,true);assert.equal(f.notes.length,0);
  f.contexts[0].releaseResume();await flush();assert.equal(f.notes.length,0);
  // A quiet permission preparation can remain useful to the next real alert.
  const next=f.player.play();await flush();assert.equal(f.contexts.length,1);assert.equal(f.notes.length,3);
  f.player.pause();await next;f.player.dispose();
});

test("a hanging resume fails within one second, releases its context and permits a clean retry",async()=>{
  const f=fixture();let outcome="pending";
  const work=f.player.play().then(()=>{outcome="played";},error=>{outcome=error.name;});
  f.timers.advance(999);await flush();assert.equal(outcome,"pending");
  void f.player.prepare().catch(()=>{});assert.equal(f.contexts[0].resumeCalls,2);
  f.timers.advance(1);await work;
  assert.equal(outcome,"NotAllowedError");assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.notes.length,0);
  const next=f.player.play();assert.equal(f.contexts.length,2);
  f.contexts[0].releaseResume();await flush();
  assert.equal(f.notes.length,0);assert.equal(f.contexts[1].state,"suspended");
  f.contexts[1].releaseResume();await flush();assert.equal(f.notes.length,3);
  f.player.pause();await next;f.player.dispose();assert.equal(f.timers.count(),0);
});

test("a new interaction retries a pending resume synchronously and ignores the older rejection",async()=>{
  const f=fixture(),first=f.player.prepare(),oldReject=f.contexts[0].resumeReject;
  f.timers.advance(500);const retry=f.player.prepare();
  assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].resumeCalls,2);assert.equal(f.notes.length,0);
  oldReject(Object.assign(new Error("Old gesture blocked"),{name:"NotAllowedError"}));await flush();
  assert.equal(f.contexts[0].state,"suspended");assert.equal(f.contexts[0].closeCalls,0);
  f.contexts[0].releaseResume();await Promise.all([first,retry]);
  assert.equal(f.timers.count(),0);assert.equal(f.notes.length,0);
  const work=f.player.play();await flush();assert.equal(f.notes.length,3);
  f.player.pause();await work;f.player.dispose();
});

test("an autoplay rejection is handled without retaining the failed context",async()=>{
  const f=fixture(),work=f.player.play();
  const rejected=assert.rejects(work,error=>error.name==="NotAllowedError");
  f.contexts[0].resumeReject(Object.assign(new Error("Blocked"),{name:"NotAllowedError"}));await rejected;
  assert.equal(f.notes.length,0);assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.timers.count(),0);f.player.dispose();
});

test("successive playback never overlaps or lets an old completion stop the new chime",async()=>{
  const f=fixture(),first=f.player.play();f.contexts[0].releaseResume();await flush();
  const oldCompletion=f.notes[2].onended;
  const second=f.player.play();await first;await flush();
  assert.equal(f.notes.length,6);assert.ok(f.notes.slice(0,3).every(note=>note.stopped&&note.disconnected));
  assert.ok(f.notes.slice(3).every(note=>!note.stopped));
  oldCompletion();assert.ok(f.notes.slice(3).every(note=>!note.stopped));
  f.notes[5].onended();await second;f.player.dispose();
});

test("an interrupted audio clock cannot leave playback waiting forever for onended",async()=>{
  const f=fixture(),work=f.player.play();f.contexts[0].releaseResume();await flush();
  assert.equal(f.notes.length,3);f.contexts[0].state="suspended";
  f.timers.advance(1000);await work;
  assert.ok(f.notes.every(note=>note.onended===null&&note.stopped&&note.disconnected));
  assert.equal(f.timers.count(),0);f.player.dispose();
});

test("disposal cancels pending playback and prevents late resume or reuse from creating notes",async()=>{
  const f=fixture(),work=f.player.play();f.player.dispose();await work;
  assert.equal(f.contexts[0].closeCalls,1);assert.equal(f.timers.count(),0);
  f.contexts[0].releaseResume();await flush();assert.equal(f.notes.length,0);
  await assert.rejects(f.player.prepare(),error=>error.name==="AbortError");
  await assert.rejects(f.player.play(),error=>error.name==="AbortError");
  f.player.dispose();assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].closeCalls,1);
});

test("module initialization shares one silent player and only trusted business gestures prepare it",async()=>{
  const f=fixture(),listeners=new Map(),previous=new Map();
  for(const key of ["window","document"])previous.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  const browser={location:{pathname:"/business/login"},AudioContext:f.Context};
  Object.defineProperty(globalThis,"window",{value:browser,configurable:true});
  Object.defineProperty(globalThis,"document",{value:{addEventListener(type,listener,capture){const rows=listeners.get(type)||[];rows.push({listener,capture});listeners.set(type,rows);}},configurable:true});
  let player;
  try{
    const module=await import(`../src/business-message-melody.js?shared-trusted-lifecycle`);player=module.businessMessageMelody();
    assert.equal(player,module.businessMessageMelody());assert.equal(f.contexts.length,0);
    assert.equal(listeners.get("pointerdown").length,1);assert.equal(listeners.get("keydown").length,1);
    assert.equal(listeners.get("pointerdown")[0].capture,true);
    const pointer=listeners.get("pointerdown")[0].listener,key=listeners.get("keydown")[0].listener;
    pointer({isTrusted:false});assert.equal(f.contexts.length,0);
    browser.location.pathname="/";key({isTrusted:true});assert.equal(f.contexts.length,0);
    browser.location.pathname="/business-applicant-privacy/";pointer({isTrusted:true});assert.equal(f.contexts.length,0);
    browser.location.pathname="/business/login";pointer({isTrusted:true});key({isTrusted:true});
    assert.equal(f.contexts.length,1);assert.equal(f.contexts[0].resumeCalls,2);assert.equal(f.notes.length,0);
    f.contexts[0].releaseResume();await flush();assert.equal(f.notes.length,0);
    const work=player.play();await flush();assert.equal(f.notes.length,3);
    player.pause();await work;await player.prepare();assert.equal(f.contexts.length,1);assert.equal(f.notes.length,3);
  }finally{
    player?.dispose();f.player.dispose();
    for(const [key,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
});
