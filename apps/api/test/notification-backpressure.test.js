import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { journeyFixture } from "./helpers.js";
import { notificationStreamHub } from "../src/notification-stream.js";

test("notification catch-up uses one drain listener and cleans it on disconnect", async () => {
  const f = await journeyFixture(); let hub;
  try {
    await f.login("customer@calai.local", "LocalCustomer!4310");
    const user = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get();
    const session = f.db.prepare("SELECT id FROM sessions WHERE user_id=?").get(user.id), stamp = f.config.now().toISOString();
    for(let i=0;i<30;i++)f.db.prepare("INSERT INTO user_notifications(id,user_id,type,title,message,event_key,created_at) VALUES(?,?,'order_status','Demo notice','A demo notification',?,?)").run(`buffer-${i}`,user.id,`buffer:${i}`,stamp);
    const req = new EventEmitter(), res = new EventEmitter(); let ended=false;
    Object.assign(res,{writeHead(){},flushHeaders(){},write(){return false;},end(){ended=true;}});
    hub=notificationStreamHub(f.db,{now:f.config.now,pollMs:10000,heartbeatMs:10000});
    hub.subscribe({req,res,userId:user.id,sessionId:session.id});
    assert.equal(res.listenerCount("drain"),1);
    hub.close();assert.equal(res.listenerCount("drain"),0);assert.equal(ended,true);
  } finally { hub?.close(); await f.close(); }
});
