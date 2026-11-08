import assert from "node:assert/strict";
import test from "node:test";
import {customerDeletionHtml} from "../customer-deletion.js";
test("deletion form requires deliberate password confirmation and gives pending requests a status instead of another destructive form",()=>{
  const enabled={privacyPolicy:{enabled:true},erasure:[]};
  const html=customerDeletionHtml(enabled);
  assert.match(html,/data-verified="true"/);assert.match(html,/type="password" autocomplete="current-password" required/);
  assert.match(html,/type="checkbox" required value="DELETE MY ACCOUNT"/);assert.doesNotMatch(html,/checked/);
  assert.match(html,/Reason <span class="meta">Optional/);
  const pending=customerDeletionHtml({...enabled,erasure:[{status:"requested",requestedAt:"2026-11-08T00:00:00.000Z",dueAt:"2026-12-08T00:00:00.000Z"}]});
  assert.match(pending,/Deletion request requested/);assert.doesNotMatch(pending,/<form/);
  const failed=customerDeletionHtml({});assert.match(failed,/temporarily unavailable/);assert.doesNotMatch(failed,/<form/);
  const legacy=customerDeletionHtml({privacyPolicy:{enabled:false},deletion:[]});assert.match(legacy,/Request account closure/);assert.doesNotMatch(legacy,/name="password"/);
  assert.doesNotMatch(customerDeletionHtml({...enabled,erasure:[{status:'<script>alert(1)</script>',requestedAt:"2026-11-08T00:00:00.000Z"}]}),/<script>/);
});
