import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { adminNavigation, ownerNavigation } from "../src/model.js";
import { calaiNavigation } from "../src/calai-platform-model.js";
import { tabletQuery, tabletRecordPath, tabletMetadataDraft, tabletMetadataPayload, tabletReassignmentPayload, tabletDisablePayload, tabletRegistrationPayload, tabletCurrentTerminalId, tabletEnrolmentPayload, tabletManagementRefreshPayload, tabletManagementPresentation, tabletEvidence, tabletHistory } from "../src/admin-tablet-model.js";
import {tabletApplicationPayload,tabletDirectoryAssignmentPath,tabletApplicationModeLabel} from '../src/admin-tablet-model.js';

const first="11111111-1111-4111-8111-111111111111",second="22222222-2222-4222-8222-222222222222",terminal="33333333-3333-4333-8333-333333333333";
const draft={displayName:"Calai-0001",serialNumber:"0F02-ABC/01",requestedStartupProduct:"cal-eats",intuneManagedDeviceId:first,entraDeviceId:"",startupGroupId:second,startupProfileId:""};

test('tablet app selection sends one versioned device command without granting roles or claiming Windows setup',()=>{
 for(const applicationProducts of['calai','cal-eats','both']){
  const value=tabletApplicationPayload({displayName:'  Kitchen tablet  ',businessId:first,applicationProducts,terminalId:terminal,paired:true,role:'owner',startupApplied:true},{expectedRevision:4});
  assert.deepEqual(value,{displayName:'Kitchen tablet',businessId:first,applicationProducts,expectedRevision:4});
 }
 assert.deepEqual(tabletApplicationPayload({displayName:'New Surface',businessId:first,applicationProducts:'cal-eats'},{creating:true}),{displayName:'New Surface',businessId:first,applicationProducts:'cal-eats'});
 assert.throws(()=>tabletApplicationPayload({displayName:'Kitchen tablet',businessId:first,applicationProducts:'all'},{expectedRevision:4}),/Choose Calai/);
 assert.throws(()=>tabletApplicationPayload({displayName:'Kitchen tablet',businessId:'Luton',applicationProducts:'cal-eats'},{expectedRevision:4}),/identifier/);
 assert.throws(()=>tabletApplicationPayload({displayName:'Kitchen tablet',businessId:first,applicationProducts:'both'},{expectedRevision:0}),/Refresh/);
 assert.equal(tabletDirectoryAssignmentPath(first),`/api/admin/tablets/directory/${first}`);assert.throws(()=>tabletDirectoryAssignmentPath('../../devices'),/identifier/);
 assert.equal(tabletRecordPath(first,'configuration'),`/api/admin/tablets/${first}/configuration`);assert.equal(tabletApplicationModeLabel(null),'Existing business access');
});
test("the central fleet has an administrator route and does not become an owner menu",async()=>{
 assert.ok(adminNavigation.some(([name,path])=>name==="Tablets"&&path==="/admin/tablets"));
 assert.ok(calaiNavigation.some(([name,path])=>name==="Tablets"&&path==="/admin/tablets"),"The same central fleet is reachable from either system product menu");
 assert.ok(!ownerNavigation("owner").some(([,path])=>path==="/admin/tablets"));
 const app=await readFile(new URL("../src/App.jsx",import.meta.url),"utf8");assert.match(app,/<Route path="tablets" element=\{<AdminTablets\/>\}/);assert.ok(app.indexOf('path="tablets"')>app.indexOf('<PlatformAdminShell'));
});
test("fleet queries are bounded, keep explicit location identity and encode search without selecting by name",()=>{
 const query=new URLSearchParams(tabletQuery({q:"  Calai-0001 & north  ",status:"pending_handoff",page:2,businessId:first}));
 assert.equal(query.get("q"),"Calai-0001 & north");assert.equal(query.get("businessId"),first);assert.equal(query.get("pageSize"),"20");assert.equal(query.get("status"),"pending_handoff");assert.equal(query.get("page"),"2");
 assert.equal(new URLSearchParams(tabletQuery({page:-1,status:"ready"})).get("page"),"1");assert.equal(new URLSearchParams(tabletQuery({status:"ready"})).has("status"),false);
 assert.throws(()=>tabletQuery({businessId:"Restaurant Luton"}),/valid identifier/);
 assert.throws(()=>tabletRecordPath("../../another-account"),/valid identifier/);assert.throws(()=>tabletRecordPath(first,"accept"),/Unsupported/);
 assert.equal(tabletRecordPath(first,"reassign"),`/api/admin/tablets/${first}/reassign`);
});
test("a Calai-only or unassigned tablet can be recorded without creating an Eats identity or serial-based authority",()=>{
 const value=tabletMetadataPayload({...draft,role:"owner",appliedAt:"now",online:true,products:{"cal-eats":true}},{creating:true,businessId:null});
 assert.equal(value.businessId,null);assert.equal(value.requestedStartupProduct,"cal-eats");assert.equal(value.serialNumber,draft.serialNumber);
 for(const key of["role","appliedAt","online","products","password","expectedRevision","terminalId"])assert.equal(Object.hasOwn(value,key),false);
 const calai=tabletMetadataPayload({...draft,requestedStartupProduct:"calai"},{creating:true,businessId:first,terminalId:terminal});assert.equal(calai.businessId,first);assert.equal(calai.terminalId,terminal);assert.equal(calai.requestedStartupProduct,"calai");
});
test("metadata editing whitelists display aliases and requested setup with an exact revision, never an assignment or applied flag",()=>{
 const row={displayName:"Existing",serialNumber:null,requestedStartupProduct:"calai",mapping:{intuneManagedDeviceId:first}};
 assert.equal(tabletMetadataDraft(row).serialNumber,"");assert.equal(tabletMetadataDraft(row).intuneManagedDeviceId,first);
 const value=tabletMetadataPayload({...draft,businessId:second,lifecycleState:"assigned",physicallyVerifiedAt:"now",displayName:"  Renamed display alias  "},{expectedRevision:7});assert.equal(value.displayName,"Renamed display alias");assert.equal(value.expectedRevision,7);
 for(const key of["businessId","lifecycleState","physicallyVerifiedAt","terminalId","startupUrl","windowsName"])assert.equal(Object.hasOwn(value,key),false);
 assert.equal(tabletMetadataPayload({...draft,serialNumber:"",requestedStartupProduct:""},{expectedRevision:1}).serialNumber,null);
 for(const mutation of[{displayName:"x"},{serialNumber:"serial\nother"},{requestedStartupProduct:"https://other.invalid"},{startupGroupId:"another business"}])assert.throws(()=>tabletMetadataPayload({...draft,...mutation},{expectedRevision:1}));
 for(const expectedRevision of[0,-1,"2",undefined])assert.throws(()=>tabletMetadataPayload(draft,{expectedRevision}),/Refresh/);
 const original={displayName:draft.displayName,serialNumber:draft.serialNumber,requestedStartupProduct:draft.requestedStartupProduct,mapping:{intuneManagedDeviceId:first,entraDeviceId:null,startupGroupId:second,startupProfileId:null}};
 assert.deepEqual(tabletMetadataPayload({...draft,displayName:"New alias"},{expectedRevision:7,original}),{displayName:"New alias",expectedRevision:7},"Renaming an alias must not request or cancel Windows setup again");
 assert.throws(()=>tabletMetadataPayload(draft,{expectedRevision:7,original}),/No requested settings/);
});
test("reassignment requires explicit quarantine and never claims session cleanup or destination authority",()=>{
 const value=tabletReassignmentPayload({businessId:second,requestedStartupProduct:"calai",reason:"   Physical handoff\nfor a new location   ",confirmQuarantine:true,cleanupVerified:true,ownerSession:"private",effectiveStartupProduct:"calai"},3);
 assert.deepEqual(value,{expectedRevision:3,businessId:second,requestedStartupProduct:"calai",reason:"Physical handoff for a new location",confirmQuarantine:true});
 for(const confirmed of[false,undefined,"true"])assert.throws(()=>tabletReassignmentPayload({businessId:second,reason:"A recorded safe handoff",confirmQuarantine:confirmed},3),/Confirm/);
 assert.throws(()=>tabletReassignmentPayload({businessId:"name is not proof",reason:"A recorded safe handoff",confirmQuarantine:true},3),/valid identifier/);
 assert.throws(()=>tabletDisablePayload("short",3,true),/reason/);assert.throws(()=>tabletDisablePayload("A deliberate disabled record",3,false),/Confirm/);
 assert.deepEqual(tabletDisablePayload("A deliberate disabled record",3,true),{expectedRevision:3,reason:"A deliberate disabled record"});
});
test("requested configuration, management contact, device receipt, applied evidence and physical checks stay distinct",()=>{
 const evidence=tabletEvidence({requestedStartupProduct:"cal-eats",lifecycleState:"assigned",management:{state:"online",lastContactAt:"2026-11-22T10:00:00Z"},application:{state:"online"},startup:{state:"requested",requestedAt:"2026-11-22T10:00:00Z",assignedAt:null,offeredAt:null,appliedAt:null,physicallyVerifiedAt:null},applied:true,physicalVerified:true});
 assert.equal(evidence.find(item=>item.key==="requested").value,"Cal-Eats-first");
 assert.equal(evidence.find(item=>item.key==="assigned").value,"Not confirmed");assert.equal(evidence.find(item=>item.key==="offered").value,"No offer recorded");assert.equal(evidence.find(item=>item.key==="received").value,"No device acknowledgement");assert.equal(evidence.find(item=>item.key==="applied").value,"Not confirmed");assert.equal(evidence.find(item=>item.key==="physical").value,"Not verified");
 const offered=tabletEvidence({requestedStartupProduct:"cal-eats",startup:{offeredAt:"2026-11-22T10:01:00Z",receivedAt:null,appliedAt:null,physicallyVerifiedAt:null}});assert.equal(offered.find(item=>item.key==="offered").value,"Offer recorded; receipt unconfirmed");assert.equal(offered.find(item=>item.key==="received").value,"No device acknowledgement");assert.equal(offered.find(item=>item.key==="applied").value,"Not confirmed");
 assert.equal(tabletEvidence({requestedStartupProduct:"calai",startup:{appliedAt:"2026-11-22T11:00:00Z"}}).find(item=>item.key==="physical").value,"Not verified");
});
test("tablet history renders the actual administrator reference, reason and whitelisted previous/current fields",()=>{
 const entry={id:first,actorUserId:second,action:"tablet_reassignment_quarantined",createdAt:"2026-11-22T12:00:00Z",details:{reason:"A verified physical handoff is required",previous:{businessId:first,displayName:"Original",password:"private"},current:{businessId:first,requestedBusinessId:second,displayName:"Requested name",ownerSession:"private"},windowsConfigurationChanged:false}};
 const view=tabletHistory(entry);assert.equal(view.actor,second);assert.equal(view.reason,entry.details.reason);assert.equal(view.label,"Reassignment requested; physical handoff required");assert.ok(view.changes.some(change=>change.label==="Requested location reference"&&change.after===second));assert.equal(JSON.stringify(view).includes("private"),false);assert.equal(view.changes.some(change=>change.label==="Current location reference"),false,"No old location has silently transferred");
});
test("registration reconciliation records only an existing exact reference and explicit same-device confirmation",()=>{
 assert.deepEqual(tabletRegistrationPayload({terminalId:terminal,confirmSamePhysicalDevice:true,businessId:second,privateKey:"not included",cleanupVerified:true},8),{expectedRevision:8,terminalId:terminal,confirmSamePhysicalDevice:true});
 for(const confirmation of[undefined,false,"true"])assert.throws(()=>tabletRegistrationPayload({terminalId:terminal,confirmSamePhysicalDevice:confirmation},8),/Confirm/);
 assert.throws(()=>tabletRegistrationPayload({terminalId:"serial-is-not-a-key",confirmSamePhysicalDevice:true},8),/identifier/);
 assert.equal(tabletRecordPath(first,"registration"),`/api/admin/tablets/${first}/registration`);
});

test("unlinked inventory history never claims that an application identity or printer was revoked",()=>{
 const unbound=tabletHistory({action:"tablet_access_disabled",details:{previous:{terminalId:null},current:{terminalId:null}}});assert.equal(unbound.label,"Fleet record disabled; no application registration linked");
 const linked=tabletHistory({action:"tablet_access_disabled",details:{previous:{terminalId:terminal},current:{terminalId:terminal}}});assert.equal(linked.label,"Fleet record disabled; linked Cal-Eats authority revoked");
});

test("central private enrolment requires current setup permission and exact replacement acknowledgement",()=>{
 const row={revision:4,actions:{canIssueSetup:true,currentTerminalId:terminal},registration:{registered:true,terminalId:terminal}};
 assert.deepEqual(tabletEnrolmentPayload(row,{confirmed:true,confirmReplaceTerminalId:terminal,cleanupDone:true,ownerSession:"not transferred"}),{expectedRevision:4,confirmReplaceTerminalId:terminal});
 for(const replacement of[null,first,undefined])assert.throws(()=>tabletEnrolmentPayload(row,{confirmed:true,confirmReplaceTerminalId:replacement}),/exact currently registered/);
 for(const confirmed of[false,"true",undefined])assert.throws(()=>tabletEnrolmentPayload(row,{confirmed,confirmReplaceTerminalId:terminal}),/Confirm the intended/);
 const unpaired={revision:1,actions:{canIssueSetup:true,currentTerminalId:null},registration:null};
 assert.deepEqual(tabletEnrolmentPayload(unpaired,{confirmed:true}),{expectedRevision:1,confirmReplaceTerminalId:null});
 const unboundInventory={revision:2,actions:{canIssueSetup:true,currentTerminalId:terminal},registration:null};
 assert.equal(tabletCurrentTerminalId(unboundInventory),terminal,"Current business registration is authoritative even when this inventory row is unbound");
 assert.deepEqual(tabletEnrolmentPayload(unboundInventory,{confirmed:true,confirmReplaceTerminalId:terminal}),{expectedRevision:2,confirmReplaceTerminalId:terminal});
 assert.throws(()=>tabletEnrolmentPayload(unboundInventory,{confirmed:true}),/exact currently registered/);
 assert.equal(tabletCurrentTerminalId({...row,actions:{...row.actions,currentTerminalId:null}}),null,"A historical attached registration cannot override the server current-registration capability");
 assert.throws(()=>tabletEnrolmentPayload(unpaired,{confirmed:true,confirmReplaceTerminalId:terminal}),/terminal changed/);
 for(const blocked of[{actions:{canIssueSetup:false,setupBlockReason:"Physical handoff remains quarantined."}},{actions:{canIssueSetup:"true"}},{actions:{}}])assert.throws(()=>tabletEnrolmentPayload({...unpaired,...blocked},{confirmed:true}),/quarantined|unavailable/);
 assert.throws(()=>tabletEnrolmentPayload({...unpaired,revision:0},{confirmed:true}),/Refresh/);
 assert.equal(tabletRecordPath(first,"enrolment"),`/api/admin/tablets/${first}/enrolment`);
 assert.equal(tabletRecordPath(first,"installer"),`/api/admin/tablets/${first}/installer`);
});

test("read-only management refresh sends no device results, script content or completion override",()=>{
 assert.deepEqual(tabletManagementRefreshPayload({revision:9,actions:{canRefreshManagement:true},changed:true,cleanupVerified:true,script:"not sent",management:{configured:true}}),{expectedRevision:9});
 assert.throws(()=>tabletManagementRefreshPayload({revision:9,actions:{canRefreshManagement:false,managementBlockReason:"Management connection is not configured."}}),/not configured/);
 assert.throws(()=>tabletManagementRefreshPayload({revision:9,management:{configured:true}}),/unavailable/);
 assert.equal(tabletRecordPath(first,"management/refresh"),`/api/admin/tablets/${first}/management/refresh`);
 assert.throws(()=>tabletRecordPath(first,"management/complete"),/Unsupported/);
});

test("management check success is not a startup change, application presence or completed handoff",()=>{
 const evidence={identityMatched:true,collectedAt:"2026-11-22T17:00:00Z",contactAt:"2026-11-22T16:50:00Z",scriptRef:first,scriptSha256:"a".repeat(64),execution:{status:"AlreadyCorrect",changed:false,observedAt:"2026-11-22T16:50:00Z",source:"microsoft_graph"},physicalStartupVerified:false,applicationPresenceVerified:false};
 const row={management:{configured:true,evidence,evidenceMatchesCurrentRevision:false,latestRefresh:{status:"failed",errorCode:"GRAPH_UNAVAILABLE"}},startup:{state:"requested"},handoff:{state:"pending_physical_cleanup",completionSupported:false}};
 const view=tabletManagementPresentation(row);
 assert.equal(view.evidenceMatchesCurrentRevision,false,"Retained evidence cannot claim to match a newly edited fleet revision");assert.equal(view.executionLabel,"Startup check passed — no changes made");assert.equal(view.execution.changed,false);assert.equal(view.job.status,"failed");assert.equal(view.evidence.collectedAt,evidence.collectedAt,"A failed refresh retains the dated earlier observation");
 assert.equal(tabletEvidence(row).find(stage=>stage.key==="applied").value,"Not confirmed");assert.equal(tabletEvidence(row).find(stage=>stage.key==="physical").value,"Not verified");
 assert.equal(Object.hasOwn(view,"application"),false);assert.equal(Object.hasOwn(view,"handoffCompleted"),false);
 const unmatched=tabletManagementPresentation({management:{configured:true,evidence:{...evidence,identityMatched:false,execution:{status:"Applied",changed:true,source:"microsoft_graph"}}}});assert.equal(unmatched.evidence,null);assert.equal(unmatched.execution,null);
 const unsupported=tabletManagementPresentation({management:{evidence:{...evidence,execution:{status:"Succeeded",changed:true,source:"typed_by_administrator"}}}});assert.equal(unsupported.execution,null);assert.equal(unsupported.executionLabel,"No verified script execution result");
});
