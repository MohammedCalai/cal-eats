# Read-only tablet management and central enrolment

Migration72 adds management refresh jobs, normalised evidence and central one-use enrolment references in Cal-Eats only. Existing restaurant, order, money, terminal and printer records are preserved.

The central Tablets page can issue the existing ten-minute, single-use Windows enrolment document and download the independent Cal-Eats companion installer. It requires a current secured human system-administrator web session, current record revision and exact confirmation of any active registration being replaced. Issuance does not revoke a working terminal or mint an operational grant. Signed physical pairing performs the existing atomic replacement and binds the real registration back to the originating fleet row. A record edit, quarantine, removed administrator or changed registration invalidates outstanding setup. The recorded serial guards accidental installation where supplied; it is not authentication or hardware attestation. Calai-only accounts retain their separate native provisioning and no Cal-Eats restaurant is created for them.

## Dedicated Microsoft connection

Live collection is disabled by default. The remaining external dependency is a separately approved Microsoft Entra application identity, its private certificate in the deployment secret store and administrator consent for only these application permissions:

- `DeviceManagementManagedDevices.Read.All` for exact managed-device identity/contact.
- `DeviceManagementScripts.Read.All` for reviewed platform-script metadata and run-state reads.

Set the documented `CAL_EATS_INTUNE_*` environment variables only after that connection is approved. The certificate SHA256 thumbprint is public metadata; the PEM private key must remain outside Git and ordinary app/browser sessions. The implementation uses installed MSAL Node confidential-client certificate authentication. Existing mail credentials/token caches are not reused. The collector has no Graph write, Sync, restart, assignment, script-upload, device-disablement or policy-edit operation.

An administrator's explicit refresh creates one durable leased job per tablet. Concurrent refreshes deduplicate; transient read failures retry at most three times with bounded backoff. Expired read leases can be recovered safely. Identity HTTP requests are cancelled after twelve seconds, authentication has a fifteen-second deadline and each collection has a sixty-second deadline; the durable queue owns retries. The worker rechecks current inventory revision and current administrator authority after awaited provider work before storing results. Invalid, denied or failed reads preserve previous evidence with its timestamp and stale-revision indicator. Errors are redacted; provider token/error bodies and raw script output are not stored.

The normal backup sanitizer removes central pairing references before their one-use parents and cancels pending management reads/leases in the backup copy only. A restored system requires deliberate new requests and fresh enrolment. Dated management evidence remains separate from live application state. With the existing approved privacy-retention policy enabled, completed operational observations/jobs follow its thirty-day monitoring window; active read jobs and financial/device-identity records are not purged by this rule.

Provider requests use fixed HTTPS Microsoft endpoints, no redirects, streamed two-MB JSON limits and bounded run-state pagination. Continuation URLs must stay on the exact approved script's run-state path. Exact Intune ID, Entra ID and serial must agree. Scripts require a server-approved ID/SHA256 manifest and supported typed output. Device contact uses Graph v1.0; platform-script evidence currently uses the supported but more frequently changing Intune beta API. The initial run-state lookup is bounded to ten pages of100; a discovered exact run-state ID is reused for subsequent reads of the same inventory revision. A larger initial report fails visibly at the configured bound rather than scanning indefinitely or inventing a result.

## Evidence limitations

Management contact does not prove application presence, sign-in, terminal readiness or paper output. A Graph success badge without supported output establishes no startup result. `AlreadyCorrect, Changed=false` is a management-reported successful configuration check with no change. Current reviewed payload hash plus a run timestamp after its last modification is correlation, not cryptographic attestation of executed bytes. These observations never advance an unrelated requested configuration's applied/physical stages. Existing signed application/printing observations remain independent.

Cross-restaurant handoff remains quarantined: browser/native sessions, protected printer tenant credentials and queued receipts all need an authorised cleanup/rebinding procedure. This integration supplies no unsupported handoff-completion or bypass button and does not modify Calai's protected watchdog, printer or authentication.

References: [managed device reads](https://learn.microsoft.com/en-us/graph/api/intune-devices-manageddevice-get?view=graph-rest-1.0), [platform-script run-state reads](https://learn.microsoft.com/en-us/graph/api/intune-devices-devicemanagementscriptdevicestate-list?view=graph-rest-beta), [current Intune Graph scopes](https://learn.microsoft.com/en-us/intune/developer/configure-graph-api-access), and [MSAL certificate configuration](https://learn.microsoft.com/en-us/entra/msal/javascript/node/certificate-credentials).
