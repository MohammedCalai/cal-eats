import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BACKUP_ROOT, createBackup } from "./backup.js";

test("managed backups remove temporary messages while preserving order and formal dispute records", async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"cal-eats-message-backup-")),source=path.join(directory,"source.sqlite");
  const target=path.join(BACKUP_ROOT,`calai-eats-chat-test-${randomUUID()}.sqlite`),marker="temporary-ciphertext-sentinel-not-for-backup";
  const db=new DatabaseSync(source);
  try {
    db.exec("CREATE TABLE orders(id TEXT); CREATE TABLE refund_cases(id TEXT); CREATE TABLE order_messages(ciphertext TEXT); CREATE TABLE order_message_reads(id TEXT); CREATE TABLE order_message_rate_limits(id TEXT); INSERT INTO orders VALUES('order'); INSERT INTO refund_cases VALUES('formal-case');");
    db.prepare("INSERT INTO order_messages VALUES(?)").run(marker);
    await createBackup({source,destination:target});
    const restored=new DatabaseSync(target,{readOnly:true});
    try { assert.equal(restored.prepare("SELECT COUNT(*) n FROM order_messages").get().n,0);assert.equal(restored.prepare("SELECT COUNT(*) n FROM orders").get().n,1);assert.equal(restored.prepare("SELECT COUNT(*) n FROM refund_cases").get().n,1); }
    finally { restored.close(); }
    assert.equal(fs.readFileSync(target).includes(Buffer.from(marker)),false);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM order_messages").get().n,1);
  } finally { db.close();fs.rmSync(target,{force:true});fs.rmSync(directory,{recursive:true,force:true}); }
});
