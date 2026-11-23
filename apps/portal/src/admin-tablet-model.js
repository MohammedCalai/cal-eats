const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TABLET_STATES = ["all", "assigned", "unassigned", "disabled", "pending_handoff"];
export const MAPPING_FIELDS = [
  ["intuneManagedDeviceId", "Intune managed-device ID"], ["entraDeviceId", "Entra device ID"],
  ["startupGroupId", "Startup group ID"], ["startupProfileId", "Startup profile ID"]
];
export const tabletStateLabel = value => ({ assigned: "Location recorded", unassigned: "Unassigned", disabled: "Fleet record disabled", pending_handoff: "Physical handoff required" })[value] || "Status unavailable";
export const startupProductLabel = value => value === "calai" ? "Calai-first" : value === "cal-eats" ? "Cal-Eats-first" : "Not requested";
function uuid(value, label, optional = false) { const text = String(value || "").trim(); if (!text && optional) return null; if (!UUID.test(text)) throw new Error(`${label} must be a valid identifier.`); return text.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1) throw new Error("Refresh the tablet record before changing it."); return value; }
function startup(value) { if (value === "" || value === null || value === undefined) return null; if (!["calai", "cal-eats"].includes(value)) throw new Error("Choose Calai-first or Cal-Eats-first."); return value; }
function reason(value) { const text = String(value || "").replace(/\s+/g, " ").trim(); if (text.length < 10 || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error("Add a reason of 10–300 characters."); return text; }
export function tabletQuery({ q = "", status = "all", page = 1, businessId } = {}) {
  const query = new URLSearchParams({ page: String(Math.max(1, Math.min(1000000, Math.floor(Number(page)) || 1))), pageSize: "20" });
  if (String(q).trim()) query.set("q", String(q).trim().slice(0, 100));
  if (TABLET_STATES.includes(status) && status !== "all") query.set("status", status);
  if (businessId) query.set("businessId", uuid(businessId, "Location"));
  return query.toString();
}
export function tabletRecordPath(id, action = "") { if (!["", "disable", "reassign", "registration", "enrolment", "installer", "setup-package", "management/refresh", "configuration"].includes(action)) throw new Error("Unsupported tablet action."); return `/api/admin/tablets/${uuid(id, "Tablet")}${action ? `/${action}` : ""}`; }
export const TABLET_APPLICATION_MODES = ['calai','cal-eats','both'];
export const tabletApplicationModeLabel = value => ({calai:'Calai','cal-eats':'Cal-Eats',both:'Calai + Cal-Eats'})[value] || 'Existing business access';
export function tabletApplicationPayload(draft, {expectedRevision, creating = false} = {}) {
  const displayName = String(draft.displayName || '').trim();
  if(displayName.length < 2 || displayName.length > 100 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(displayName)) throw new Error('Tablet name must contain 2–100 characters.');
  if(!TABLET_APPLICATION_MODES.includes(draft.applicationProducts)) throw new Error('Choose Calai, Cal-Eats or both.');
  const result = {displayName,businessId:uuid(draft.businessId,'Restaurant / location'),applicationProducts:draft.applicationProducts};
  if(!creating)result.expectedRevision=revision(expectedRevision);
  return result;
}
export function tabletDirectoryAssignmentPath(id) { return `/api/admin/tablets/directory/${uuid(id,'Microsoft tablet')}`; }
export function tabletMetadataDraft(row = {}) {
  return { displayName: row.displayName || "", serialNumber: row.serialNumber || "", requestedStartupProduct: row.requestedStartupProduct || "", ...Object.fromEntries(MAPPING_FIELDS.map(([key]) => [key, row.mapping?.[key] || ""])) };
}
export function tabletMetadataPayload(draft, { creating = false, expectedRevision, businessId, terminalId, original } = {}) {
  const displayName = String(draft.displayName || "").trim(), serialNumber = String(draft.serialNumber || "").trim();
  if (displayName.length < 2 || displayName.length > 100 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(displayName)) throw new Error("Tablet name must contain 2–100 characters.");
  if (serialNumber && !/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/.test(serialNumber)) throw new Error("Recorded serial must start with a letter or digit, use letters, digits, spaces or . _ : / - and be at most 120 characters.");
  const result = { displayName, serialNumber: serialNumber || null, requestedStartupProduct: startup(draft.requestedStartupProduct), ...Object.fromEntries(MAPPING_FIELDS.map(([key, label]) => [key, uuid(draft[key], label, true)])) };
  if (creating) { result.businessId = uuid(businessId, "Location", true); if (terminalId) result.terminalId = uuid(terminalId, "Existing terminal"); }
  else {
    if(original){
      const previous={displayName:original.displayName,serialNumber:original.serialNumber??null,requestedStartupProduct:original.requestedStartupProduct??null,...Object.fromEntries(MAPPING_FIELDS.map(([key])=>[key,original.mapping?.[key]??null]))};
      for(const key of Object.keys(result))if(result[key]===previous[key])delete result[key];
      if(!Object.keys(result).length)throw new Error("No requested settings have changed.");
    }
    result.expectedRevision = revision(expectedRevision);
  }
  return result;
}
export function tabletReassignmentPayload(draft, expectedRevision) {
  if (draft.confirmQuarantine !== true) throw new Error("Confirm quarantine and the required physical handoff.");
  return { expectedRevision: revision(expectedRevision), businessId: uuid(draft.businessId, "Requested location", true), requestedStartupProduct: startup(draft.requestedStartupProduct), reason: reason(draft.reason), confirmQuarantine: true };
}
export function tabletDisablePayload(value, expectedRevision, confirmed) { if (confirmed !== true) throw new Error("Confirm that this tablet record should be disabled."); return { expectedRevision: revision(expectedRevision), reason: reason(value) }; }
export function tabletRegistrationPayload(draft, expectedRevision) { if(draft.confirmSamePhysicalDevice!==true)throw new Error("Confirm that this existing registration belongs to the same physical tablet and location."); return{expectedRevision:revision(expectedRevision),terminalId:uuid(draft.terminalId,"Existing terminal"),confirmSamePhysicalDevice:true}; }
export function tabletCurrentTerminalId(row){return uuid(row?.actions?.currentTerminalId,"Current registered terminal",true);}
export function tabletEnrolmentPayload(row,{confirmed=false,confirmReplaceTerminalId=null}={}){
 if(row?.actions?.canIssueSetup!==true)throw new Error(row?.actions?.setupBlockReason||"Tablet setup is unavailable for this record.");
 if(confirmed!==true)throw new Error("Confirm the intended restaurant and physical tablet before creating a private setup file.");
 const existing=tabletCurrentTerminalId(row);
 if(existing!==null&&confirmReplaceTerminalId!==existing)throw new Error("Confirm the exact currently registered terminal before preparing its replacement.");
 if(existing===null&&confirmReplaceTerminalId!==null)throw new Error("The registered terminal changed. Refresh before creating setup.");
 return{expectedRevision:revision(row.revision),confirmReplaceTerminalId:existing};
}
export function tabletManagementRefreshPayload(row){
 if(row?.actions?.canRefreshManagement!==true)throw new Error(row?.actions?.managementBlockReason||"Management evidence refresh is unavailable.");
 return{expectedRevision:revision(row.revision)};
}
export function tabletManagementPresentation(row){
 const management=row?.management||{},candidate=management.evidence;
 const evidence=candidate?.identityMatched===true?candidate:null,execution=evidence?.execution?.source==="microsoft_graph"?evidence.execution:null;
 let executionLabel="No verified script execution result";
 if(execution?.status==="AlreadyCorrect"&&execution.changed===false)executionLabel="Startup check passed — no changes made";
 else if(execution?.changed===true)executionLabel="Startup change reported by management";
 else if(execution)executionLabel=`Management script result: ${String(execution.status||"Unavailable")}`;
 return{configured:management.configured===true,evidence,evidenceMatchesCurrentRevision:management.evidenceMatchesCurrentRevision===true,execution,executionLabel,job:management.latestRefresh||null};
}
export function tabletEvidence(row) {
  const state = row?.startup || {};
  return [
    { key: "requested", label: "Requested starting platform", value: startupProductLabel(row?.requestedStartupProduct), at: state.requestedAt || null },
    { key: "assigned", label: "Management assignment", value: state.assignedAt ? "Assignment recorded" : "Not confirmed", at: state.assignedAt || null },
    { key: "offered", label: "Offered by management", value: state.offeredAt ? state.receivedAt ? "Offer recorded" : "Offer recorded; receipt unconfirmed" : "No offer recorded", at: state.offeredAt || null },
    { key: "received", label: "Received by device", value: state.receivedAt ? "Device receipt recorded" : "No device acknowledgement", at: state.receivedAt || null },
    { key: "applied", label: "Successfully applied on device", value: state.appliedAt ? "Application evidence recorded" : "Not confirmed", at: state.appliedAt || null },
    { key: "physical", label: "Physically verified", value: state.physicallyVerifiedAt ? "Physical check recorded" : "Not verified", at: state.physicallyVerifiedAt || null }
  ];
}
const auditLabels={tablet_inventory_created:"Tablet record created",tablet_metadata_updated:"Requested settings updated",tablet_directory_assigned:"Microsoft tablet assigned",tablet_application_access_updated:"Tablet application access updated"};
export function tabletHistory(entry){
 const details=entry?.details&&typeof entry.details==='object'?entry.details:{},previous=details.previous||{},current=details.current||{},fields=[["displayName","Display name"],["businessId","Current location reference"],["requestedBusinessId","Requested location reference"],["applicationProducts","Application access"],["requestedStartupProduct","Requested starting platform"],["lifecycleState","Administrative state"],["terminalId","Cal-Eats terminal reference"]];
 const linked=Boolean(previous.terminalId||current.terminalId),label=entry?.action==='tablet_reassignment_quarantined'?(linked?'Reassignment requested; linked Cal-Eats authority quarantined':'Reassignment requested; physical handoff required'):entry?.action==='tablet_access_disabled'?(linked?'Fleet record disabled; linked Cal-Eats authority revoked':'Fleet record disabled; no application registration linked'):auditLabels[entry?.action]||String(entry?.action||"Administrative change").replaceAll("_"," ");
 return {label,actor:entry?.actorUserId||"Not returned",at:entry?.createdAt||null,reason:typeof details.reason==='string'?details.reason:null,changes:fields.filter(([key])=>previous[key]!==current[key]).map(([key,label])=>({label,before:previous[key]??null,after:current[key]??null}))};
}
