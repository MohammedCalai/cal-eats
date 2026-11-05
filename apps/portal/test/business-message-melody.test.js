import test from "node:test";
import assert from "node:assert/strict";
import {createBusinessMessageMelody} from "../src/business-message-melody.js";

function fixture(){
  const notes=[];let releaseResume;
  class Context{
    currentTime=0;state="running";destination={};
    resume(){return new Promise(resolve=>{releaseResume=resolve;});}
    createOscillator(){const note={frequency:{},connect(){return this;},disconnect(){},start(at){this.startAt=at;},stop(at){this.endAt=at;}};notes.push(note);return note;}
    createGain(){return {gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return this;},disconnect(){}};}
    close(){return Promise.resolve();}
  }
  return {player:createBusinessMessageMelody(()=>Context),notes,resume:()=>releaseResume()};
}
test("message melody finishes within one second and cancellation settles its active playback",async()=>{
  const {player,notes,resume}=fixture();let finished=false;
  const work=player.play().then(()=>{finished=true;});resume();await Promise.resolve();await Promise.resolve();
  assert.equal(notes.length,3);assert.equal(finished,false);assert.ok(Math.max(...notes.map(note=>note.endAt))<1);
  player.pause();await work;assert.equal(finished,true);
  assert.ok(notes.every(note=>note.onended===null));player.dispose();
});
test("a cancelled audio-permission preparation cannot start a late melody",async()=>{
  const {player,notes,resume}=fixture();const work=player.play();player.pause();resume();await work;
  assert.equal(notes.length,0);player.dispose();
});
