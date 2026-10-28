import assert from "node:assert/strict";
import test from "node:test";
import {businessReturnPath} from "../src/model.js";
test("support email sign-in returns to the same permitted conversation",()=>{
 assert.equal(businessReturnPath("/owner/support?case=ticket-1","restaurant"),"/owner/support?case=ticket-1");assert.equal(businessReturnPath("/admin/support?case=ticket-1","admin"),"/admin/support?case=ticket-1");
 for(const value of ["https://evil.invalid","//evil.invalid/path","/owner/../admin/support","/owner/\\evil.invalid","/admin/support"]){assert.equal(businessReturnPath(value,"restaurant"),"/owner/dashboard");}
});
