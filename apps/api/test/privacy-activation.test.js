import "../src/app.js";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import test from "node:test";
import {loadConfig} from "../src/config.js";
test("hosted policy activation couples the actual archived notice with its matching controls and leaves health collection off",()=>{
  const origin="https://eats.calai.info",version="2026-11-08-v1",approvedAt="2026-11-08T00:00:00.000Z",approvalReference="fictional-activation-test-only";
  const documents=Object.fromEntries(["terms","privacy"].map(kind=>{const archiveFile=`customer-${kind}-${version}.txt`,text=readFileSync(new URL(`../legal-documents/${archiveFile}`,import.meta.url));return[kind,{archiveFile,version,sha256:createHash("sha256").update(text).digest("hex"),url:`${origin}/legal/${kind}/${version}`,approvedAt,effectiveAt:approvedAt,approvalReference}];}));
  const base={runMode:"hosted-preview",nodeEnv:"test",origin,customerLegal:{enabled:true,documents}};
  assert.throws(()=>loadConfig(base),/activated together/);
  assert.throws(()=>loadConfig({...base,customerPrivacy:{enabled:true,version:"another-version",approvedAt,approvalReference}}),/same Privacy Notice version/);
  const config=loadConfig({...base,customerPrivacy:{enabled:true,version,approvedAt,approvalReference}});
  assert.equal(config.customerPrivacy.healthDataEnabled,false);assert.equal(config.customerLegal.documents.privacy.version,config.customerPrivacy.version);
  assert.equal(config.customerPrivacy.retention.orderContactDays,90);
});
