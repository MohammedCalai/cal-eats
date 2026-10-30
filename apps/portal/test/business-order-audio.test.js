import test from "node:test";
import assert from "node:assert/strict";
import { createOrderAudio } from "../src/business-order-audio.js";

function setup(){
  const player={paused:true,plays:0,pause(){this.paused=true;},async play(){this.plays++;if(this.blocked)throw Object.assign(new Error("Blocked"),{name:"NotAllowedError"});this.paused=false;}};
  return {player,alarm:createOrderAudio(player)};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));

test("orders ring automatically; changing count or visual popup cannot stop another pending order",async()=>{
  const {player,alarm}=setup();
  alarm.update({enabled:true,count:2,path:"/normal.wav"});await settled();
  assert.equal(player.loop,true);assert.equal(player.paused,false);assert.equal(player.volume,1);
  alarm.stopTest();assert.equal(player.paused,false);
  alarm.update({enabled:true,count:1,path:"/normal.wav"});assert.equal(player.paused,false);
  alarm.update({enabled:true,count:1,path:"/urgent.wav"});await settled();assert.equal(player.src,"/urgent.wav");assert.equal(player.loop,true);
  alarm.update({enabled:true,count:0,path:"/normal.wav"});assert.equal(player.paused,true);assert.equal(player.loop,false);
});

test("blocked autoplay recovers through an ordinary interaction without an opt-in preference",async()=>{
  const {player,alarm}=setup();player.blocked=true;
  alarm.update({enabled:true,count:1,path:"/normal.wav"});await settled();
  assert.equal(alarm.getSnapshot().ready,false);assert.match(alarm.getSnapshot().error,/interaction/);
  player.blocked=false;alarm.interact();await settled();
  assert.equal(alarm.getSnapshot().ready,true);assert.equal(alarm.getSnapshot().error,"");assert.equal(player.loop,true);assert.equal(player.paused,false);
});

test("sign-in interaction primes silently, idle sample stops, and sign-out silences the old account",async()=>{
  const {player,alarm}=setup();alarm.interact();assert.equal(player.volume,0);await settled();
  assert.equal(player.paused,true);assert.equal(alarm.getSnapshot().ready,true);
  alarm.update({enabled:true,count:0,path:"/normal.wav"});await alarm.test();
  assert.equal(alarm.getSnapshot().testing,true);alarm.stopTest();assert.equal(player.paused,true);
  alarm.update({enabled:true,count:1,path:"/normal.wav"});await settled();alarm.stop();
  assert.equal(player.paused,true);alarm.resume();assert.equal(player.paused,true);
});
