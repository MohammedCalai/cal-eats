import assert from "node:assert/strict";
import test from "node:test";
import {commissionFreePeriod,londonCommissionDay} from "../src/commission-period.js";

test("commission-free weeks preserve London midnight across both daylight-saving changes",()=>{
  const spring=commissionFreePeriod("2026-03-23",1),autumn=commissionFreePeriod("2026-10-19",1);
  assert.deepEqual(spring,{startsAt:"2026-03-23T00:00:00.000Z",endsAt:"2026-03-29T23:00:00.000Z"});
  assert.deepEqual(autumn,{startsAt:"2026-10-18T23:00:00.000Z",endsAt:"2026-10-26T00:00:00.000Z"});
  assert.equal(londonCommissionDay("2026-07-01T23:30:00Z"),"2026-07-02");
  for(const [day,weeks] of [["2026-02-30",1],["2026-06-01",0],["2026-06-01",53],["2026-06-01",1.5]])assert.throws(()=>commissionFreePeriod(day,weeks));
  assert.deepEqual(commissionFreePeriod("2026-03-23",1,"14:35"),{startsAt:"2026-03-23T14:35:00.000Z",endsAt:"2026-03-30T13:35:00.000Z"});
  assert.throws(()=>commissionFreePeriod("2026-03-29",1,"01:30"),/does not exist/);
  assert.throws(()=>commissionFreePeriod("2026-10-25",1,"01:30"),/occurs twice/);
  assert.throws(()=>commissionFreePeriod("2026-03-22",1,"01:30"),/End time does not exist/);
});
