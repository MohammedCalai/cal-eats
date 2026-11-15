import test from "node:test";
import assert from "node:assert/strict";
import {createBusinessReportEmail,reportEmailMessage} from "../src/business-report-email.js";
const path="/api/restaurant/restaurants/restaurant-123/dashboard/orders.csv?period=today";
const job=status=>({id:"report-job-123",status,recipient:"owner@example.test",errorCode:null});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){
  const calls=[],timers=new Map();let timerId=0,key=0;
  const model=createBusinessReportEmail({reportPath:path,request:(url,options)=>{const result=deferred();calls.push({url,options,...result});return result.promise;},keyFactory:()=>`report-key-${++key}`,schedule:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},cancel:id=>timers.delete(id)});
  return {model,calls,timers};
}

test("report clicks queue an attachment without downloading and check the server destination/status",async()=>{
  const f=fixture(),send=f.model.send();f.model.send();assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,"/api/restaurant/report-emails");
  assert.deepEqual(JSON.parse(f.calls[0].options.body),{reportPath:path});
  assert.equal(f.calls[0].options.headers["Idempotency-Key"],"report-key-1");
  f.calls[0].resolve(job("pending"));await send;
  assert.match(reportEmailMessage(f.model.getSnapshot().job),/queued.*owner@example.test/);
  assert.equal(f.model.getSnapshot().busy,false);
  const check=f.model.send();assert.equal(f.calls[1].url,"/api/restaurant/report-emails/report-job-123");assert.equal(f.calls[1].options.method,undefined);
  f.calls[1].resolve(job("sent"));await check;
  assert.match(reportEmailMessage(f.model.getSnapshot().job),/accepted for delivery/);
  const another=f.model.send();assert.equal(f.calls[2].options.headers["Idempotency-Key"],"report-key-2");
  f.calls[2].resolve(job("local_saved"));await another;
  assert.match(reportEmailMessage(f.model.getSnapshot().job),/No email was sent/);f.model.close();
});

test("uncertain request retries reuse one intent; unknown delivery cannot send another email",async()=>{
  const f=fixture(),first=f.model.send();f.calls[0].reject(new Error("Connection lost"));await first;
  const retry=f.model.send();assert.equal(f.calls[1].options.headers["Idempotency-Key"],"report-key-1");
  f.calls[1].resolve(job("unknown"));await retry;assert.match(reportEmailMessage(f.model.getSnapshot().job),/Contact Cal-Eats support/);
  const unknown=f.model.send();assert.equal(f.calls[2].url,"/api/restaurant/report-emails/report-job-123");
  f.calls[2].resolve(job("failed"));await unknown;
  const failedRetry=f.model.send();assert.equal(f.calls[3].options.headers["Idempotency-Key"],"report-key-2");
  f.calls[3].reject(new Error("Connection lost again"));await failedRetry;
  const repeat=f.model.send();assert.equal(f.calls[4].options.headers["Idempotency-Key"],"report-key-2");
  f.calls[4].resolve(job("pending"));await repeat;f.model.close();
});

test("request deadlines and closed report scopes cannot publish a late successful email",async()=>{
  const f=fixture(),send=f.model.send();
  const timeout=[...f.timers.values()].find(timer=>timer.delay===15000);timeout.fn();await send;
  assert.equal(f.model.getSnapshot().busy,false);assert.match(f.model.getSnapshot().error,/took too long/);
  f.calls[0].resolve(job("sent"));await Promise.resolve();assert.equal(f.model.getSnapshot().job,null);
  const next=f.model.send();assert.equal(f.calls[1].options.headers["Idempotency-Key"],"report-key-1");
  const snapshots=[];f.model.subscribe(state=>snapshots.push(state));f.model.close();const count=snapshots.length;
  assert.equal(f.calls[1].options.signal.aborted,true);f.calls[1].resolve(job("sent"));await next;
  assert.equal(snapshots.length,count);assert.equal(f.model.getSnapshot().job,null);assert.equal(f.timers.size,0);
});
