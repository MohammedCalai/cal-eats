import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertPrivacySuppressionSafe, exportPrivacySuppressionLedger, loadPinnedPrivacySuppressionLedger } from "./restore-privacy.js";
import { inspectDatabase } from "./restore-check.js";

const stamp="2026-11-01T12:00:00.000Z", now=new Date(stamp);
function fixture(filename=":memory:") {
  const db=new DatabaseSync(filename);
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,role TEXT,account_enabled INTEGER,phone TEXT,email_verified_at TEXT,merchant_offers INTEGER);
  CREATE TABLE restaurants(id TEXT PRIMARY KEY);
  CREATE TABLE orders(id TEXT PRIMARY KEY,customer_id TEXT,customer_name TEXT,customer_email TEXT,customer_phone TEXT,delivery_instructions TEXT,allergy_notes TEXT,delivery_address TEXT,total_minor INTEGER,commission_minor INTEGER);
  CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);INSERT INTO schema_migrations VALUES(49,'fixture');
  CREATE TABLE customer_erasure_tombstones(user_id TEXT,request_id TEXT,completed_at TEXT,policy_version TEXT);
  CREATE TABLE customer_erasure_holds(id TEXT,user_id TEXT,reason_code TEXT,created_by TEXT,created_at TEXT,expires_at TEXT,released_at TEXT);
  INSERT INTO users VALUES('customer','Private name','private@example.invalid','hash','customer',1,'07100000000',NULL,0);
  INSERT INTO orders VALUES('order','customer','Private name','private@example.invalid','07100000000','Private instruction','Private allergy','Private address',1100,77);`);
  return db;
}
function ledger(){return {format:"cal-eats-privacy-suppression-v1",generatedAt:stamp,tombstones:[{userId:"customer",requestId:"request",completedAt:stamp,policyVersion:"fixture-v1"}],holds:[]};}
function clearedFixture() {
  const db=fixture();
  db.exec("UPDATE users SET name='Deleted customer',email='deleted-customer@account.invalid',password_hash='!deleted',phone='',account_enabled=0;UPDATE orders SET customer_name='',customer_email='',customer_phone='',delivery_instructions='',allergy_notes='',delivery_address=NULL;INSERT INTO customer_erasure_tombstones VALUES('customer','request','2026-11-01T12:00:00.000Z','fixture-v1');");
  return db;
}

test("a current external ledger blocks an old snapshot even when that snapshot has no tombstone, without modifying the source",()=>{
  const db=fixture();
  try {
    const before=JSON.stringify(db.prepare("SELECT * FROM users").all());
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>error.code==="PRIVACY_RESTORE_SUPPRESSION_REQUIRED"&&error.findings.account_identifiers===1&&error.findings.order_contact_or_allergy_copies===1&&error.findings.suppression_tombstones_missing===1);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM users").all()),before);
    assert.equal(db.prepare("SELECT total_minor,commission_minor FROM orders").get().total_minor,1100);
    db.exec("UPDATE users SET name='Deleted customer',email='deleted-customer@account.invalid',password_hash='!deleted',phone='',account_enabled=0;UPDATE orders SET customer_name='',customer_email='',customer_phone='',delivery_instructions='',allergy_notes='',delivery_address=NULL;INSERT INTO customer_erasure_tombstones VALUES('customer','request','2026-11-01T12:00:00.000Z','fixture-v1');");
    assert.equal(assertPrivacySuppressionSafe(db,ledger(),{now}).status,"cleared");
    assert.equal(db.prepare("SELECT total_minor,commission_minor FROM orders").get().commission_minor,77);
    assert.equal(exportPrivacySuppressionLedger(db,now).tombstones[0].userId,"customer");
  } finally {db.close();}
});

test("restoration requires current holds and rejects stale or unpinned suppression inputs",()=>{
  const db=fixture();const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cal-eats-restore-privacy-test-"));
  try {
    const value={...ledger(),tombstones:[],holds:[{id:"hold",userId:"customer",reasonCode:"legal_claim",createdBy:"admin",createdAt:stamp,expiresAt:null}]};
    assert.throws(()=>assertPrivacySuppressionSafe(db,value,{now}),error=>error.findings.current_holds_missing===1);
    db.prepare("INSERT INTO customer_erasure_holds VALUES('hold','customer','legal_claim','admin',?,NULL,NULL)").run(stamp);
    assert.equal(assertPrivacySuppressionSafe(db,value,{now}).status,"cleared");
    assert.throws(()=>assertPrivacySuppressionSafe(db,value,{now:new Date("2026-11-03T12:00:00.000Z")}),/current independently verified/);
    const file=path.join(directory,"current-ledger.json"),bytes=JSON.stringify(value);fs.writeFileSync(file,bytes,{mode:0o600});
    assert.throws(()=>loadPinnedPrivacySuppressionLedger(file,"0".repeat(64)),/SHA-256/);
    assert.deepEqual(loadPinnedPrivacySuppressionLedger(file,createHash("sha256").update(bytes).digest("hex")),value);
  } finally {db.close();const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));fs.rmSync(resolved,{recursive:true,force:true});}
});

test("integrity-only inspection is explicitly not restore clearance and strict restoration fails closed without an external ledger",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cal-eats-restore-gate-test-")),file=path.join(directory,"copy.sqlite");
  const db=fixture(file);db.close();
  try {
    assert.equal(inspectDatabase(file).privacy.status,"not_checked");
    assert.throws(()=>inspectDatabase(file,{requirePrivacyClearance:true}),/latest independently verified/);
  } finally {const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));fs.rmSync(resolved,{recursive:true,force:true});}
});

test("a matching tombstone cannot clear restored recovery credentials or private mail copies and diagnostics contain counts only",()=>{
  const db=clearedFixture();
  try {
    db.exec(`CREATE TABLE account_access_tokens(id TEXT,user_id TEXT,token_hash TEXT);
      CREATE TABLE account_access_email_outbox(id TEXT,user_id TEXT,recipient TEXT,ciphertext TEXT);
      CREATE TABLE local_mail_sink(id TEXT,user_id TEXT,recipient TEXT,body TEXT);
      CREATE TABLE native_business_sessions(id TEXT,user_id TEXT,token_hash TEXT);
      INSERT INTO account_access_tokens VALUES('own-token','customer','PRIVATE_RECOVERY_HASH'),('other-token','other','other-hash');
      INSERT INTO account_access_email_outbox VALUES('own-mail','customer','private-recipient@example.invalid','PRIVATE_RECOVERY_CIPHERTEXT'),('other-mail','other','other@example.invalid','other');
      INSERT INTO local_mail_sink VALUES('own-local','customer','private-recipient@example.invalid','PRIVATE_LOCAL_TOKEN_LINK'),('other-local','other','other@example.invalid','other');
      INSERT INTO native_business_sessions VALUES('own-session','customer','PRIVATE_SESSION_HASH'),('other-session','other','other-hash');`);
    const before=JSON.stringify(db.prepare("SELECT * FROM account_access_email_outbox ORDER BY id").all());
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>{
      assert.equal(error.code,"PRIVACY_RESTORE_SUPPRESSION_REQUIRED");
      for(const table of ["account_access_tokens","account_access_email_outbox","local_mail_sink","native_business_sessions"])assert.equal(error.findings[`restored_${table}`],1);
      for(const privateValue of ["private-recipient@example.invalid","PRIVATE_RECOVERY_HASH","PRIVATE_RECOVERY_CIPHERTEXT","PRIVATE_LOCAL_TOKEN_LINK","PRIVATE_SESSION_HASH"])assert.equal(error.message.includes(privateValue),false);
      return true;
    });
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM account_access_email_outbox ORDER BY id").all()),before,"Inspection must not mutate even rejected copies");
    db.exec("DELETE FROM account_access_tokens WHERE user_id='customer';DELETE FROM account_access_email_outbox WHERE user_id='customer';");
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>{
      assert.equal(error.findings.restored_account_access_tokens,undefined);assert.equal(error.findings.restored_account_access_email_outbox,undefined);
      assert.equal(error.findings.restored_local_mail_sink,1,"The independent user association catches a local mail copy after its source credentials/outbox have gone");return true;
    });
    db.exec("INSERT INTO account_access_email_outbox VALUES('orphan-mail','customer','private-recipient@example.invalid','PRIVATE_ORPHAN_RECOVERY_MAIL');");
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>error.findings.restored_account_access_email_outbox===1&&error.findings.restored_local_mail_sink===1&&!error.message.includes("PRIVATE_ORPHAN_RECOVERY_MAIL"));
    for(const table of ["account_access_tokens","account_access_email_outbox","local_mail_sink","native_business_sessions"])db.prepare(`DELETE FROM ${table} WHERE user_id='customer'`).run();
    assert.equal(assertPrivacySuppressionSafe(db,ledger(),{now}).status,"cleared");
    for(const table of ["account_access_tokens","account_access_email_outbox","local_mail_sink","native_business_sessions"])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id='other'`).get().n,1);
    assert.deepEqual({...db.prepare("SELECT total_minor,commission_minor FROM orders").get()},{total_minor:1100,commission_minor:77});
  } finally {db.close();}
});

test("order-linked support and mail to other recipients remain quarantined until the erased customer's exact related copies are removed",()=>{
  const db=clearedFixture();
  try {
    db.exec(`INSERT INTO orders VALUES('other-order','other','','','','','',NULL,2000,140);
      CREATE TABLE support_cases(id TEXT,user_id TEXT,order_id TEXT,subject TEXT,message TEXT);
      CREATE TABLE support_case_messages(id TEXT,case_id TEXT,sender_user_id TEXT,ciphertext TEXT);
      CREATE TABLE user_notifications(id TEXT,user_id TEXT,customer_id TEXT,order_id TEXT,conversation_id TEXT,support_case_id TEXT);
      CREATE TABLE customer_transactional_email_outbox(id TEXT,customer_id TEXT,notification_id TEXT,order_id TEXT,support_case_id TEXT,payload TEXT);
      CREATE TABLE order_confirmation_email_outbox(id TEXT,order_id TEXT,recipient TEXT);
      INSERT INTO support_cases VALUES('direct','customer',NULL,'Account data removed',''),('linked','merchant','order','Original support subject','PRIVATE_ORDER_LINKED_SUPPORT'),('unrelated','other','other-order','Other subject','Other body');
      INSERT INTO support_case_messages VALUES('linked-reply','linked','merchant','PRIVATE_SUPPORT_REPLY'),('sent-reply','unrelated','customer','PRIVATE_SENT_REPLY'),('other-reply','unrelated','merchant','Other reply');
      INSERT INTO user_notifications VALUES('source-notice','merchant',NULL,'order',NULL,NULL),('other-notice','other',NULL,'other-order',NULL,NULL);
      INSERT INTO customer_transactional_email_outbox VALUES('direct-mail','customer',NULL,NULL,NULL,'PRIVATE_DIRECT_MAIL'),('order-mail','merchant',NULL,'order',NULL,'PRIVATE_ORDER_MAIL'),('case-mail','merchant',NULL,NULL,'linked','PRIVATE_CASE_MAIL'),('notification-mail','merchant','source-notice',NULL,NULL,'PRIVATE_NOTIFICATION_MAIL'),('other-mail','other','other-notice','other-order','unrelated','Other payload');
      INSERT INTO order_confirmation_email_outbox VALUES('own-alert','order','private-recipient@example.invalid'),('other-alert','other-order','other@example.invalid');`);
    const before=JSON.stringify(db.prepare("SELECT * FROM support_cases ORDER BY id").all());
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>{
      assert.equal(error.code,"PRIVACY_RESTORE_SUPPRESSION_REQUIRED");assert.equal(error.findings.support_original_bodies,1);assert.equal(error.findings.support_reply_bodies,2);
      assert.equal(error.findings.restored_customer_transactional_email_outbox,4);assert.equal(error.findings.restored_order_confirmation_email_outbox,1);
      assert.equal(error.message.includes("PRIVATE_"),false);assert.equal(error.message.includes("private-recipient@example.invalid"),false);return true;
    });
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM support_cases ORDER BY id").all()),before);
    db.exec("UPDATE support_cases SET subject='Account data removed',message='' WHERE id='linked';DELETE FROM support_case_messages WHERE id IN ('linked-reply','sent-reply');DELETE FROM customer_transactional_email_outbox WHERE id<>'other-mail';DELETE FROM order_confirmation_email_outbox WHERE id='own-alert';DELETE FROM user_notifications WHERE id='source-notice';");
    assert.equal(assertPrivacySuppressionSafe(db,ledger(),{now}).status,"cleared");
    assert.equal(db.prepare("SELECT message FROM support_cases WHERE id='unrelated'").get().message,"Other body");assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_transactional_email_outbox").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM support_case_messages").get().n,1);
    assert.equal(db.prepare("SELECT commission_minor FROM orders WHERE id='order'").get().commission_minor,77);
  } finally {db.close();}
});

test("older optional support/mail schemas retain direct-user checks without requiring later relation columns",()=>{
  const db=clearedFixture();
  try {
    db.exec(`CREATE TABLE support_cases(id TEXT,user_id TEXT,subject TEXT,message TEXT);
      CREATE TABLE support_case_messages(id TEXT,case_id TEXT,ciphertext TEXT);
      CREATE TABLE customer_transactional_email_outbox(customer_id TEXT,payload TEXT);
      INSERT INTO support_cases VALUES('legacy-case','customer','Account data removed','');
      INSERT INTO support_case_messages VALUES('legacy-reply','legacy-case','PRIVATE_LEGACY_REPLY');
      INSERT INTO customer_transactional_email_outbox VALUES('customer','PRIVATE_LEGACY_MAIL');`);
    assert.throws(()=>assertPrivacySuppressionSafe(db,ledger(),{now}),error=>error.findings.support_reply_bodies===1&&error.findings.restored_customer_transactional_email_outbox===1);
    db.exec("DELETE FROM support_case_messages;DELETE FROM customer_transactional_email_outbox;");
    assert.equal(assertPrivacySuppressionSafe(db,ledger(),{now}).status,"cleared");
  } finally {db.close();}
});
