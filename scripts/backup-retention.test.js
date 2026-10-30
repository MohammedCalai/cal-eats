import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { journeyFixture } from "../apps/api/test/helpers.js";
import { createBackup, BACKUP_ROOT } from "./backup.js";
import { checkBackup } from "./restore-check.js";

test("backup removes both temporary message families while preserving the source and formal records", async () => {
  const f = await journeyFixture();
  const destination = path.join(BACKUP_ROOT, `retention-${randomUUID()}.sqlite`);
  try {
    const customer = f.db.prepare("SELECT id FROM users WHERE email='customer@calai.local'").get();
    const restaurant = f.db.prepare("SELECT id,name FROM restaurants WHERE status='approved'").get();
    const stamp = f.config.now().toISOString(), order = randomUUID(), thread = randomUUID();
    f.db.prepare("INSERT INTO orders(id,restaurant_id,restaurant_name,customer_id,status,subtotal_minor,total_minor,commission_minor,payment_method,payment_status,fulfillment,idempotency_key,request_hash,created_at,updated_at) VALUES(?,?,?,?,'placed',1000,1000,70,'cash','cash_due','collection',?,?,?,?)").run(order,restaurant.id,restaurant.name,customer.id,order,"hash",stamp,stamp);
    f.db.prepare("INSERT INTO restaurant_customer_threads VALUES(?,?,?,'open',?,?,?)").run(thread,restaurant.id,customer.id,stamp,stamp,stamp);
    f.db.prepare("INSERT INTO restaurant_customer_thread_sequences VALUES(?,?)").run(thread,17);
    f.db.prepare("INSERT INTO order_messages VALUES(?,?,?,'customer','fixture','hash','TEMPORARY_ORDER_BODY','nonce','tag','key',?,?)").run("order-message",order,customer.id,stamp,stamp);
    f.db.prepare("INSERT INTO restaurant_customer_messages(id,thread_id,sender_user_id,sender_role,idempotency_key,request_hash,ciphertext,nonce,auth_tag,key_version,created_at,expires_at,ingest_sequence) VALUES(?,?,?,'customer','fixture','hash','TEMPORARY_CUSTOMER_BODY','nonce','tag','key',?,?,17)").run("customer-message",thread,customer.id,stamp,stamp);
    f.db.prepare("INSERT INTO order_message_reads VALUES(?,?,?,?,?)").run(order,customer.id,stamp,"order-message",stamp);
    f.db.prepare("INSERT INTO order_message_rate_limits VALUES(?,?,0,1)").run(customer.id,order);
    f.db.prepare("INSERT INTO restaurant_customer_message_reads VALUES(?,?,?,?,?,17)").run(thread,customer.id,stamp,"customer-message",stamp);
    f.db.prepare("INSERT INTO restaurant_customer_message_rate_limits VALUES(?,?,0,1)").run(customer.id,thread);
    f.db.prepare("INSERT INTO order_message_incidents(id,order_id,reporter_user_id,reporter_role,reason,created_at,updated_at) VALUES(?,?,?,'customer','Retain formal incident',?,?)").run("incident",order,customer.id,stamp,stamp);
    await createBackup({source:f.config.dbPath,destination});
    const copy = new DatabaseSync(destination,{readOnly:true});
    try {
      for (const table of ["order_messages","order_message_reads","order_message_rate_limits","restaurant_customer_messages","restaurant_customer_message_reads","restaurant_customer_message_rate_limits"]) {
        assert.equal(copy.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
        assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,1,`source ${table}`);
      }
      assert.equal(copy.prepare("SELECT COUNT(*) n FROM orders WHERE id=?").get(order).n,1);
      assert.equal(copy.prepare("SELECT COUNT(*) n FROM order_message_incidents WHERE id='incident'").get().n,1);
      assert.equal(copy.prepare("SELECT COUNT(*) n FROM restaurant_customer_threads WHERE id=?").get(thread).n,1);
      assert.deepEqual({...copy.prepare("SELECT * FROM restaurant_customer_thread_sequences WHERE thread_id=?").get(thread)},{...f.db.prepare("SELECT * FROM restaurant_customer_thread_sequences WHERE thread_id=?").get(thread)});
    } finally {copy.close();}
    assert.equal(checkBackup(destination).foreignKeyViolations,0);
    const bytes = fs.readFileSync(destination);
    assert.equal(bytes.includes(Buffer.from("TEMPORARY_ORDER_BODY")),false);
    assert.equal(bytes.includes(Buffer.from("TEMPORARY_CUSTOMER_BODY")),false);
  } finally {fs.rmSync(destination,{force:true});await f.close();}
});

test("backup tools respect configured database and managed backup paths", () => {
  const database = path.join(BACKUP_ROOT,"configured-source.sqlite"), directory = path.join(BACKUP_ROOT,"configured-backups");
  const source = `import {DEFAULT_SOURCE,BACKUP_ROOT} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname,"backup.js")).href)}; console.log(JSON.stringify({source:DEFAULT_SOURCE,directory:BACKUP_ROOT}));`;
  const result = execFileSync(process.execPath,["--input-type=module","-e",source],{encoding:"utf8",env:{...process.env,CALAI_DB_PATH:database,CALAI_BACKUP_DIR:directory}});
  assert.deepEqual(JSON.parse(result),{source:database,directory});
});
