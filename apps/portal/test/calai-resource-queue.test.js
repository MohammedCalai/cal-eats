import test from "node:test";
import assert from "node:assert/strict";
import {createCalaiResourceQueue} from "../src/calai-resource-queue.js";
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
test("a confirmed-save invalidation waits for a fresh read rather than publishing an older pending list",async()=>{
 const first=deferred(),second=deferred(),values=[];let calls=0,finished=false;
 const queue=createCalaiResourceQueue({read:()=>++calls===1?first.promise:second.promise,onValue:value=>values.push(value)});
 const old=queue.reload(),saved=queue.reload(true).then(()=>{finished=true;});queue.reload(true);queue.reload(false);assert.equal(calls,1);
 first.resolve(["old tenant name"]);while(calls<2)await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(values,[]);assert.equal(finished,false);
 second.resolve(["updated tenant name"]);await Promise.all([old,saved]);assert.equal(calls,2);assert.deepEqual(values,[["updated tenant name"]]);assert.equal(finished,true);queue.dispose();
});
test("ordinary overlapping polls share a request without scheduling an unnecessary successor",async()=>{
 const pending=deferred(),values=[];let calls=0;const queue=createCalaiResourceQueue({read:()=>{calls++;return pending.promise;},onValue:value=>values.push(value)});
 const a=queue.reload(),b=queue.reload();pending.resolve("current");await Promise.all([a,b]);assert.equal(calls,1);assert.deepEqual(values,["current"]);queue.dispose();
});
test("closing or changing a resource scope suppresses a delayed result and any queued refetch",async()=>{
 const pending=deferred(),values=[],errors=[];let calls=0;const queue=createCalaiResourceQueue({read:()=>{calls++;return pending.promise;},onValue:value=>values.push(value),onError:error=>errors.push(error)});
 const old=queue.reload();queue.reload(true);queue.dispose();pending.resolve("old private scope");await old;assert.equal(calls,1);assert.deepEqual(values,[]);assert.deepEqual(errors,[]);await queue.reload(true);assert.equal(calls,1);
});
