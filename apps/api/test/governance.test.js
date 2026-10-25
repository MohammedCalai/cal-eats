import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { routeAdminGovernance, runGovernanceReminders } from "../src/admin-governance.js";
import { applyGovernanceMigration } from "../src/governance-migration.js";
import { journeyFixture } from "./helpers.js";

async function invoke(db,config,session,path,method="GET",body=null){
  const req=Readable.from(body===null?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.headers=body===null?{}:{"content-type":"application/json"};
  const output={status:null,body:null};const res={writeHead(status){output.status=status;},end(value){output.body=value?JSON.parse(String(value)):null;},setHeader(){}};
  try{await routeAdminGovernance({req,res,url:new URL(`http://local${path}`),db,config,session});}catch(error){output.status=error.status??500;output.body={error:{code:error.code??"INTERNAL_ERROR",message:error.message}};}return output;
}

test("account governance prevents self lockout and revokes both session kinds",async()=>{
  const f=await journeyFixture();try{applyGovernanceMigration(f.db);const admin=f.db.prepare("SELECT * FROM users WHERE role='admin'").get(),customer=f.db.prepare("SELECT * FROM users WHERE role='customer'").get(),session={user:{id:admin.id,role:"admin"}};
    const self=await invoke(f.db,f.config,session,`/api/admin/governance/accounts/${admin.id}`,"PATCH",{enabled:false,reason:"Unsafe self disable"});assert.equal(self.status,409);assert.equal(self.body.error?.code??self.body.code,"SELF_LOCKOUT");
    f.db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").run(randomUUID(),customer.id,randomUUID(),"2099-01-01T00:00:00.000Z","2026-01-01T00:00:00.000Z");
    f.db.prepare("INSERT INTO native_sessions(id,user_id,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,NULL)").run(randomUUID(),customer.id,randomUUID(),"2026-01-01T00:00:00.000Z","2099-01-01T00:00:00.000Z");
    const disabled=await invoke(f.db,f.config,session,`/api/admin/governance/accounts/${customer.id}`,"PATCH",{enabled:false,reason:"Confirmed support review"});assert.equal(disabled.status,200);assert.equal(disabled.body.data.enabled,false);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sessions WHERE user_id=? AND revoked_at IS NULL").get(customer.id).n,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM native_sessions WHERE user_id=? AND revoked_at IS NULL").get(customer.id).n,0);
  }finally{await f.close();}
});

test("membership governance protects tenant paths and the final owner",async()=>{
  const f=await journeyFixture();try{applyGovernanceMigration(f.db);const admin=f.db.prepare("SELECT * FROM users WHERE role='admin'").get(),session={user:{id:admin.id,role:"admin"}},members=f.db.prepare("SELECT * FROM restaurant_memberships ORDER BY restaurant_id").all(),first=members[0],other=members.find(x=>x.restaurant_id!==first.restaurant_id);assert.ok(other);
    const crossed=await invoke(f.db,f.config,session,`/api/admin/governance/restaurants/${first.restaurant_id}/memberships/${other.user_id}`,"PATCH",{permission:"staff",reason:"Wrong tenant path"});assert.equal(crossed.status,404);
    const last=await invoke(f.db,f.config,session,`/api/admin/governance/restaurants/${first.restaurant_id}/memberships/${first.user_id}`,"PATCH",{permission:"staff",reason:"Would remove final owner"});assert.equal(last.status,409);assert.equal(last.body.error?.code??last.body.code,"LAST_OWNER");
  }finally{await f.close();}
});

test("refund reminders and escalation are durable, deduplicated and never decide a case",async()=>{
  const f=await journeyFixture();try{applyGovernanceMigration(f.db);const login=await f.login("customer@calai.local","LocalCustomer!4310"),restaurant=(await f.json("/api/restaurants")).body.data[0],item=(await f.json(`/api/restaurants/${restaurant.id}/menu`)).body.data.items[0],order=await f.json("/api/orders",{method:"POST",cookie:login,headers:{"Idempotency-Key":"governance-reminder-order"},body:{restaurantId:restaurant.id,items:[{menuItemId:item.id,quantity:1}],paymentMethod:"mock_card",fulfillment:"collection"}});assert.equal(order.status,201,order.text);const created=await f.json("/api/refund-cases",{method:"POST",cookie:login,body:{orderId:order.body.data.id,reason:"quality",description:"Reminder scheduling test"}});assert.equal(created.status,201,created.text);const c=f.db.prepare("SELECT * FROM refund_cases WHERE id=?").get(created.body.data.id);
    f.db.prepare("UPDATE refund_cases SET status='awaiting_customer',updated_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(c.id);
    const episodeOne=randomUUID();f.db.prepare("INSERT INTO refund_case_events VALUES(?,?,?,?,?,?)").run(episodeOne,c.id,null,"request_information","{}","2026-01-01T00:00:00.000Z");
    const reminderConfig={...f.config,now:()=>new Date("2026-01-02T18:00:00.000Z")};assert.deepEqual(runGovernanceReminders(f.db,reminderConfig),{reminders:1,escalations:0});assert.deepEqual(runGovernanceReminders(f.db,reminderConfig),{reminders:0,escalations:0});
    const escalationConfig={...f.config,now:()=>new Date("2026-01-03T01:00:00.000Z")};assert.deepEqual(runGovernanceReminders(f.db,escalationConfig),{reminders:0,escalations:1});assert.deepEqual(runGovernanceReminders(f.db,escalationConfig),{reminders:0,escalations:0});
    assert.equal(f.db.prepare("SELECT status FROM refund_cases WHERE id=?").get(c.id).status,"awaiting_customer");assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE event_key LIKE ?").get(`refund:${c.id}:%`).n,2);
    const episodeTwo=randomUUID();f.db.prepare("UPDATE refund_cases SET status='under_review',updated_at='2026-01-02T02:00:00.000Z' WHERE id=?").run(c.id);runGovernanceReminders(f.db,{...f.config,now:()=>new Date("2026-01-02T02:00:00.000Z")});f.db.prepare("INSERT INTO refund_case_events VALUES(?,?,?,?,?,?)").run(episodeTwo,c.id,null,"request_information","{}","2026-01-03T00:00:00.000Z");f.db.prepare("UPDATE refund_cases SET status='awaiting_customer',updated_at='2026-01-03T00:00:00.000Z' WHERE id=?").run(c.id);
    assert.deepEqual(runGovernanceReminders(f.db,{...f.config,now:()=>new Date("2026-01-04T18:00:00.000Z")}),{reminders:1,escalations:0});assert.equal(f.db.prepare("SELECT episode_key FROM refund_response_deadlines WHERE case_id=?").get(c.id).episode_key,episodeTwo);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM user_notifications WHERE event_key LIKE ?").get(`refund:${c.id}:%`).n,3);
  }finally{await f.close();}
});
