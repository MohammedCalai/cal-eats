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
