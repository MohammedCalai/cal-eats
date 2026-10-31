import test from "node:test";
import assert from "node:assert/strict";
import {readBusinessSoundPreference,saveBusinessSoundPreference,subscribeBusinessSoundPreference} from "../src/business-sound-preference.js";
test("sound defaults on, saves an explicit choice and isolates accounts",t=>{
  const priorWindow=globalThis.window,priorStorage=globalThis.localStorage,values=new Map();
  globalThis.window=new EventTarget();globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  t.after(()=>{globalThis.window=priorWindow;globalThis.localStorage=priorStorage;});
  assert.equal(readBusinessSoundPreference("owner-a"),true);
  const changes=[],stop=subscribeBusinessSoundPreference("owner-a",value=>changes.push(value));
  saveBusinessSoundPreference("owner-b",false);assert.deepEqual(changes,[]);
  saveBusinessSoundPreference("owner-a",false);assert.equal(readBusinessSoundPreference("owner-a"),false);assert.deepEqual(changes,[false]);
  saveBusinessSoundPreference("owner-a",true);assert.deepEqual(changes,[false,true]);
  stop();saveBusinessSoundPreference("owner-a",false);assert.deepEqual(changes,[false,true]);
});
