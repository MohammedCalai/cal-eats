[CmdletBinding()]
param([string]$NodePath='',[string]$DeviceName='Restaurant tablet',[string]$EnrolmentPath='',[string]$TargetSerial='',[switch]$ForgetRegistration)
$ErrorActionPreference='Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell.' }
$TerminalIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$TerminalPrincipal=New-Object Security.Principal.WindowsPrincipal($TerminalIdentity)
if (-not $TerminalPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Managed administrator setup is required.' }
# A central-admin download can be limited to its recorded tablet. This prevents
# installation on the wrong device; server pairing still requires signed proof.
$TerminalBoundSerial='__TARGET_SERIAL__'
if ($TerminalBoundSerial -and $TargetSerial -and $TargetSerial -ne $TerminalBoundSerial) { throw 'The target serial cannot override this tablet-specific installer.' }
$TerminalExpectedSerial=if ($TerminalBoundSerial) { $TerminalBoundSerial } else { $TargetSerial }
if ($TerminalExpectedSerial -and ([string](Get-CimInstance Win32_BIOS).SerialNumber).Trim() -ne $TerminalExpectedSerial) { throw 'This installer does not match this tablet serial. Download the installer for this tablet.' }
$TerminalEmbeddedEnrolmentBase64='__ENROLMENT_BASE64__'
$TerminalEmbeddedDeviceNameBase64='__DEVICE_NAME_BASE64__'
$TerminalManagedSetupBase64='__MANAGED_SETUP_BASE64__'
function ConvertFrom-TerminalSetupData([string]$Encoded) {
 if ([string]::IsNullOrEmpty($Encoded) -or $Encoded.Length -gt 16384 -or $Encoded -notmatch '\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z') { throw 'Embedded tablet setup data is invalid.' }
 try {
  $Bytes=[Convert]::FromBase64String($Encoded)
  $Json=[Text.UTF8Encoding]::new($false,$true).GetString($Bytes)
  $JsonStart=$Json.TrimStart()
  if (-not $JsonStart.StartsWith('{',[StringComparison]::Ordinal) -and -not $JsonStart.StartsWith('"',[StringComparison]::Ordinal)) { throw 'Unexpected embedded JSON shape.' }
  $Value=$Json | ConvertFrom-Json -ErrorAction Stop
 } catch { throw 'Embedded tablet setup data is invalid.' }
 return ,$Value
}
function Assert-TerminalEnrolmentData {
 param($Setup,[switch]$Embedded,[switch]$Expired,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow)
 if ($Setup -isnot [pscustomobject]) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 $Allowed=@('schemaVersion','product','apiBaseUrl','businessId','terminalId','code','challenge','expiresAt')
 $Required=@('apiBaseUrl','businessId','terminalId','code','challenge','expiresAt')
 if ($Embedded) { $Required=$Allowed }
 $Names=@($Setup.PSObject.Properties | ForEach-Object { $_.Name })
 if (@($Names | Where-Object { $Allowed -cnotcontains $_ }).Count -gt 0 -or @($Required | Where-Object { $Names -cnotcontains $_ }).Count -gt 0) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 if ($Expired -and $Names.Count -notin @(6,8)) { throw 'Saved legacy tablet setup data is invalid.' }
 if (($Names -ccontains 'schemaVersion') -and (($Setup.schemaVersion -isnot [int] -and $Setup.schemaVersion -isnot [long]) -or $Setup.schemaVersion -ne 1)) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 if (($Names -ccontains 'product') -and ($Setup.product -isnot [string] -or $Setup.product -cne 'calai-business-terminal')) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 $Uuid='\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
 foreach ($Field in @('businessId','terminalId')) { if ($Setup.$Field -isnot [string] -or $Setup.$Field -cnotmatch $Uuid -or $Setup.$Field -ceq '00000000-0000-0000-0000-000000000000') { throw 'Owner-approved tablet enrolment is invalid or expired.' } }
 if ($Setup.apiBaseUrl -isnot [string] -or $Setup.apiBaseUrl -cne 'https://eats.calai.info' -or $Setup.code -isnot [string] -or $Setup.challenge -isnot [string] -or $Setup.expiresAt -isnot [string]) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 $CodePattern='\A[A-Za-z0-9_-]{8,200}\z';$ChallengePattern='\A[A-Za-z0-9_-]{20,300}\z'
 if ($Embedded -or $Expired) { $CodePattern='\A[A-Za-z0-9_-]{32}\z';$ChallengePattern='\A[A-Za-z0-9_-]{43}\z' }
 if ($Setup.code -cnotmatch $CodePattern -or $Setup.challenge -cnotmatch $ChallengePattern) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 $Expires=[DateTimeOffset]::MinValue
 if (-not [DateTimeOffset]::TryParse($Setup.expiresAt,[ref]$Expires) -or
     ($Expired -and $Expires -ge $Now) -or
     (-not $Expired -and $Expires -le $Now)) { throw 'Owner-approved tablet enrolment does not have the required expiry.' }
 if (($Embedded -or $Expired) -and ($Expires -gt $Now.AddMinutes(11) -or $Expires.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture) -cne $Setup.expiresAt)) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
}
function Assert-TerminalSetupIdentity {
 param($Setup,$SavedIdentity,[switch]$Embedded,[switch]$ForgetRegistration)
 if ($Embedded -and $ForgetRegistration) { throw 'Embedded setup cannot retire an existing tablet identity. Use the separate authorised replacement process.' }
 if ($null -eq $SavedIdentity) { return }
 $Uuid='\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
 if ($SavedIdentity -isnot [pscustomobject] -or ($SavedIdentity.schemaVersion -isnot [int] -and $SavedIdentity.schemaVersion -isnot [long]) -or $SavedIdentity.schemaVersion -ne 1 -or $SavedIdentity.product -cne 'calai-business-terminal' -or $SavedIdentity.terminalId -isnot [string] -or $SavedIdentity.terminalId -cnotmatch $Uuid -or $SavedIdentity.terminalId -ceq '00000000-0000-0000-0000-000000000000' -or $SavedIdentity.paired -isnot [bool] -or ($SavedIdentity.paired -and ($SavedIdentity.businessId -isnot [string] -or $SavedIdentity.businessId -cnotmatch $Uuid -or $SavedIdentity.businessId -ceq '00000000-0000-0000-0000-000000000000'))) { throw 'The existing tablet identity is invalid. Use the supported maintenance process.' }
 if ($Setup -and ($SavedIdentity.terminalId -cne $Setup.terminalId -or ($SavedIdentity.paired -and $SavedIdentity.businessId -cne $Setup.businessId)) -and ($Embedded -or -not $ForgetRegistration)) { throw 'This tablet has a different registration. Use explicit owner replacement.' }
}
function Test-TerminalManagedJoin([string]$Status,[string]$ExpectedDeviceId) {
 $Uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
 if ($Status.Length -gt 65536 -or $ExpectedDeviceId -cnotmatch ('\A'+$Uuid+'\z')) { return $false }
 # Use the documented machine-join fields, independent of section headings or
 # displayed locale. A missing/duplicated or unsupported field fails closed.
 $Join=[regex]::Matches($Status,'(?m)^[ \t]*AzureAdJoined[ \t]*:[ \t]*([^\r\n]*?)[ \t]*\r?$')
 $Ids=[regex]::Matches($Status,'(?m)^[ \t]*DeviceId[ \t]*:[ \t]*([^\r\n]*?)[ \t]*\r?$')
 return ($Join.Count -eq 1 -and $Join[0].Groups[1].Value -ceq 'YES' -and $Ids.Count -eq 1 -and
  $Ids[0].Groups[1].Value -cmatch ('\A'+$Uuid+'\z') -and $Ids[0].Groups[1].Value -ieq $ExpectedDeviceId)
}
function Read-TerminalDeviceJoin {
 $Start=[Diagnostics.ProcessStartInfo]::new((Join-Path ([Environment]::SystemDirectory) 'dsregcmd.exe'),'/status')
 $Start.UseShellExecute=$false;$Start.CreateNoWindow=$true
 $Start.RedirectStandardOutput=$true;$Start.RedirectStandardError=$true
 $Process=[Diagnostics.Process]::Start($Start)
 try {
  $Output=$Process.StandardOutput.ReadToEndAsync()
  $Discard=$Process.StandardError.ReadToEndAsync()
  if (-not $Process.WaitForExit(20000)) { $Process.Kill();throw 'Windows Entra join checking timed out.' }
  if ($Process.ExitCode -ne 0) { throw 'Windows Entra join checking failed.' }
  return $Output.GetAwaiter().GetResult()
 } finally { $Process.Dispose() }
}
$TerminalManagedSetup=$null
if ($TerminalManagedSetupBase64) {
 if ($TerminalIdentity.User.Value -cne 'S-1-5-18') { throw 'Run this managed tablet setup as LOCAL SYSTEM.' }
 if (-not $TerminalBoundSerial -or $NodePath -or $TargetSerial -or $EnrolmentPath -or $ForgetRegistration -or
     $PSBoundParameters.ContainsKey('DeviceName') -or $TerminalEmbeddedEnrolmentBase64 -or $TerminalEmbeddedDeviceNameBase64) {
  throw 'Managed tablet setup cannot be combined with another installation or registration override.'
 }
 $TerminalManagedSetup=ConvertFrom-TerminalSetupData $TerminalManagedSetupBase64
 $ManagedUuid='\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
 $SetupFields=@($TerminalManagedSetup.PSObject.Properties | ForEach-Object { $_.Name })
 if ($TerminalManagedSetup -isnot [pscustomobject] -or $SetupFields.Count -ne 2 -or $SetupFields -cnotcontains 'jobId' -or
     $SetupFields -cnotcontains 'entraDeviceId' -or $TerminalManagedSetup.jobId -isnot [string] -or
     $TerminalManagedSetup.jobId -cnotmatch $ManagedUuid -or $TerminalManagedSetup.jobId -ceq [guid]::Empty.ToString() -or
     $TerminalManagedSetup.entraDeviceId -isnot [string] -or $TerminalManagedSetup.entraDeviceId -cnotmatch $ManagedUuid -or
     $TerminalManagedSetup.entraDeviceId -ceq [guid]::Empty.ToString()) { throw 'Managed tablet setup data is invalid.' }
 if (-not (Test-TerminalManagedJoin (Read-TerminalDeviceJoin) $TerminalManagedSetup.entraDeviceId)) { throw 'This tablet does not match the selected Entra device.' }
}
$TerminalHasEmbeddedEnrolment=-not [string]::IsNullOrEmpty($TerminalEmbeddedEnrolmentBase64)
if ($TerminalHasEmbeddedEnrolment -and (-not $TerminalBoundSerial -or $EnrolmentPath -or $ForgetRegistration)) { throw 'Embedded setup requires its exact tablet serial and cannot be combined with an enrolment file or registration reset.' }
if ($TerminalEmbeddedDeviceNameBase64) {
 $EmbeddedDeviceName=ConvertFrom-TerminalSetupData $TerminalEmbeddedDeviceNameBase64
 if ($EmbeddedDeviceName -isnot [string] -or $EmbeddedDeviceName.Trim().Length -lt 2 -or $EmbeddedDeviceName.Length -gt 80 -or $EmbeddedDeviceName -match '[\r\n\0]') { throw 'Invalid tablet name.' }
 if ($PSBoundParameters.ContainsKey('DeviceName') -and $DeviceName -cne $EmbeddedDeviceName) { throw 'The tablet name cannot override this prepared setup.' }
 $DeviceName=$EmbeddedDeviceName
}
if ($DeviceName.Length -lt 2 -or $DeviceName.Length -gt 80 -or $DeviceName -match '[\r\n\0]') { throw 'Invalid tablet name.' }
$TerminalSetup=$null
if ($TerminalHasEmbeddedEnrolment) { $TerminalSetup=ConvertFrom-TerminalSetupData $TerminalEmbeddedEnrolmentBase64;Assert-TerminalEnrolmentData -Setup $TerminalSetup -Embedded }
elseif ($EnrolmentPath) {
 try { $TerminalSetup=Get-Content -LiteralPath $EnrolmentPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 Assert-TerminalEnrolmentData -Setup $TerminalSetup
}
$TerminalRoot=[IO.Path]::GetFullPath((Join-Path $env:ProgramData 'CalEatsTerminalAuth'))
$TerminalParent=Split-Path -Parent $TerminalRoot
$TerminalTaskName='CalEats - Terminal Auth Broker'
$TerminalConfig=Join-Path $TerminalRoot 'config.json'
$TerminalVar=Join-Path $TerminalRoot 'var'
$TerminalProgramFilesX86=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
function Assert-TerminalProtection([string]$Path) {
 $CheckedAcl=Get-Acl -LiteralPath $Path
 $CheckedOwner=([Security.Principal.NTAccount]::new($CheckedAcl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
 if ($CheckedOwner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'A tablet program path has an untrusted owner.' }
 foreach ($CheckedRule in $CheckedAcl.Access) {
  $CheckedSid=$CheckedRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  $CheckedWrite=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  if ($CheckedRule.AccessControlType -eq 'Allow' -and ($CheckedRule.FileSystemRights -band $CheckedWrite) -ne 0 -and $CheckedSid -notin @('S-1-5-18','S-1-5-32-544','S-1-3-0')) { throw 'A tablet program path is user-writable.' }
 }
}
function Assert-TerminalPath([string]$Path) {
 $Full=[IO.Path]::GetFullPath($Path)
 if ($Full -ne $TerminalRoot -and -not $Full.StartsWith($TerminalRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Tablet files must remain in the managed installation.' }
 $Cursor=$Full
 while ($Cursor -and $Cursor.StartsWith($TerminalRoot,[StringComparison]::OrdinalIgnoreCase)) {
  if (Test-Path -LiteralPath $Cursor) { $Item=Get-Item -LiteralPath $Cursor -Force; if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.LinkType -eq 'HardLink') { throw 'Redirected tablet files are unsupported.' };Assert-TerminalProtection $Cursor }
  $Cursor=Split-Path -Parent $Cursor
 }
 return $Full
}
function New-TerminalDirectoryAcl {
 $Acl=New-Object Security.AccessControl.DirectorySecurity
 $Acl.SetAccessRuleProtection($true,$false);$Acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 foreach ($Sid in @('S-1-5-18','S-1-5-32-544')) { $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
 return $Acl
}
function Set-TerminalProtection([string]$Path) {
 $Acl=New-TerminalDirectoryAcl
 Set-Acl -LiteralPath $Path -AclObject $Acl
}
function New-TerminalExclusiveDirectory([string]$Path) {
 if (-not ('CalEatsTerminalInstallDirectory' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CalEatsTerminalInstallDirectory {
  [StructLayout(LayoutKind.Sequential)]
  private struct SecurityAttributes {
    public int Length;
    public IntPtr SecurityDescriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool InheritHandle;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
  public static int Create(string path, byte[] descriptor) {
    GCHandle pinned = GCHandle.Alloc(descriptor, GCHandleType.Pinned);
    try {
      SecurityAttributes attributes = new SecurityAttributes {
        Length = Marshal.SizeOf(typeof(SecurityAttributes)),
        SecurityDescriptor = pinned.AddrOfPinnedObject(),
        InheritHandle = false
      };
      return CreateDirectoryW(path, ref attributes) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      pinned.Free();
    }
  }
}
'@
 }
 $Acl=New-TerminalDirectoryAcl
 $CreateError=[CalEatsTerminalInstallDirectory]::Create($Path,$Acl.GetSecurityDescriptorBinaryForm())
 if ($CreateError -in @(80,183)) { throw 'A tablet directory appeared during protected installation.' }
 if ($CreateError -ne 0) { throw "The tablet directory could not be created securely (Windows error $CreateError)." }
}
function Initialize-TerminalDirectory([string]$Path) {
 $Path=Assert-TerminalPath $Path
 # ProgramData can grant inherited write access. Install the protected ACL
 # in the exclusive creation itself so no user-writable directory is exposed.
 if (-not (Test-Path -LiteralPath $Path)) { New-TerminalExclusiveDirectory $Path }
 if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw 'A protected tablet directory is unavailable.' }
 $Path=Assert-TerminalPath $Path
 Set-TerminalProtection $Path
}
function Test-TerminalNode([string]$Path) {
 if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
 if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
 $Signature=Get-AuthenticodeSignature -LiteralPath $Path
 if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch '(?i)\bOpenJS Foundation\b') { return $false }
 return [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion -match '^24\.(?:19|[2-9][0-9]|[1-9][0-9]{2,})\.'
}
function Assert-TerminalPrivateFile([string]$Path) {
 if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'The saved legacy tablet setup is not a private file.' }
 Assert-TerminalPath $Path | Out-Null
 $Acl=Get-Acl -LiteralPath $Path
 foreach ($Rule in $Acl.Access) {
  $Sid=$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($Rule.AccessControlType -eq 'Allow' -and $Sid -notin @('S-1-5-18','S-1-5-32-544')) { throw 'The saved legacy tablet setup is not a private file.' }
 }
}
function Get-TerminalExpiredLegacyId([string]$Json,[DateTimeOffset]$Now=[DateTimeOffset]::UtcNow) {
 # The former installer wrote six scalar keys or the original eight issuer
 # keys. Refuse duplicate/escaped keys and ambiguous JSON even if a parser
 # normalises it into a superficially valid object.
 $Property='"([A-Za-z]+)"\s*:\s*(?:1|"[A-Za-z0-9_:/.-]+")'
 if ($Json.Length -gt 4096 -or $Json -cnotmatch ('\A\s*\{\s*'+$Property+'(?:\s*,\s*'+$Property+')*\s*\}\s*\z')) { throw 'Saved legacy tablet setup data is invalid.' }
 $Keys=@([regex]::Matches($Json,$Property)|ForEach-Object {$_.Groups[1].Value})
 if ($Keys.Count -notin @(6,8) -or @($Keys | Sort-Object -CaseSensitive -Unique).Count -ne $Keys.Count) { throw 'Saved legacy tablet setup data is invalid.' }
 $Setup=$Json | ConvertFrom-Json -ErrorAction Stop
 Assert-TerminalEnrolmentData -Setup $Setup -Expired -Now $Now
 return $Setup.terminalId
}
function Assert-TerminalManagedState([string]$IdentityPath,[string]$ManagedPath,[string]$ManualPath,[string]$JobId,[switch]$CheckExpiredLegacy) {
 $HasIdentity=Test-Path -LiteralPath $IdentityPath
 $ExpiredSetupId=$null
 if (Test-Path -LiteralPath $ManualPath) {
  if (-not $CheckExpiredLegacy -or $HasIdentity) { throw 'A separate authorised tablet setup is already present.' }
  Assert-TerminalPrivateFile $ManualPath
  $LegacyItem=Get-Item -LiteralPath $ManualPath -Force
  if ($LegacyItem.Length -lt 1 -or $LegacyItem.Length -gt 4096) { throw 'Saved legacy tablet setup data is invalid.' }
  $ExpiredSetupId=Get-TerminalExpiredLegacyId (Get-Content -LiteralPath $ManualPath -Raw)
 }
 if ($HasIdentity) {
  $Identity=Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json -ErrorAction Stop
  Assert-TerminalSetupIdentity -SavedIdentity $Identity
  if (-not $Identity.paired -or $Identity.terminalId -cne $JobId) { throw 'This tablet already has a different registration.' }
 }
 if (Test-Path -LiteralPath $ManagedPath) {
  $Item=Get-Item -LiteralPath $ManagedPath -Force
  if ($Item.Length -lt 1 -or $Item.Length -gt 4096) { throw 'Protected managed setup data is invalid.' }
  $Pending=Get-Content -LiteralPath $ManagedPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if ($Pending -isnot [pscustomobject] -or $Pending.schemaVersion -ne 1 -or $Pending.jobId -isnot [string] -or
      $Pending.jobId -cnotmatch $ManagedUuid -or $Pending.state -cnotin @('pending','closed')) {
   throw 'Protected managed setup data is invalid.'
  }
  if (($Pending.jobId -cne $JobId -and $Pending.state -ceq 'pending') -or
      ($Pending.jobId -ceq $JobId -and $Pending.state -ceq 'closed')) { throw 'This tablet already has a different or closed managed setup.' }
 }
 return $ExpiredSetupId
}
$InstallLock=[Threading.Mutex]::new($false,'Global\CalEatsTerminalInstallV1')
$InstallLockHeld=$false
try {
 try { $InstallLockHeld=$InstallLock.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $InstallLockHeld=$true }
 if (-not $InstallLockHeld) { throw 'Another protected tablet installation is running.' }
Assert-TerminalPath $TerminalRoot | Out-Null
if (-not (Test-Path -LiteralPath $TerminalParent -PathType Container) -or ((Get-Item -LiteralPath $TerminalParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The Windows application-data directory is unavailable or redirected.' }
$IdentityPath=Assert-TerminalPath (Join-Path $TerminalVar 'terminal-identity.json')
$ManagedPath=Assert-TerminalPath (Join-Path $TerminalVar 'managed-terminal-setup.json')
$ManualPath=Assert-TerminalPath (Join-Path $TerminalRoot 'enrolment.json')
if ($TerminalManagedSetup) {
 $ExpiredSetupId=Assert-TerminalManagedState $IdentityPath $ManagedPath $ManualPath $TerminalManagedSetup.jobId -CheckExpiredLegacy
} elseif (($TerminalSetup -or $ForgetRegistration) -and (Test-Path -LiteralPath $ManagedPath)) {
 $PendingManaged=Get-Content -LiteralPath $ManagedPath -Raw | ConvertFrom-Json -ErrorAction Stop
 if ($PendingManaged.schemaVersion -ne 1 -or $PendingManaged.state -cne 'closed') { throw 'A managed tablet setup is in progress.' }
}
if ($TerminalSetup -and (Test-Path -LiteralPath $IdentityPath)) {
 $SavedIdentity=Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json -ErrorAction Stop
 Assert-TerminalSetupIdentity -Setup $TerminalSetup -SavedIdentity $SavedIdentity -Embedded:$TerminalHasEmbeddedEnrolment -ForgetRegistration:$ForgetRegistration
}
if (Test-Path -LiteralPath $TerminalConfig) { Assert-TerminalPath $TerminalConfig | Out-Null;$Saved=Get-Content -LiteralPath $TerminalConfig -Raw | ConvertFrom-Json;if ($Saved.product -ne 'calai-business-terminal' -or $Saved.apiBaseUrl -ne 'https://eats.calai.info') { throw 'Another product owns this installation.' } }
$ExistingTask=Get-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($ExistingTask) {
 if ($ExistingTask.Actions.Count -ne 1 -or $ExistingTask.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'Another program owns the tablet task name.' }
 $ExistingNode=Assert-TerminalPath $ExistingTask.Actions[0].Execute
 $ExistingRelease=Split-Path -Parent $ExistingNode
 $ExistingEntry=Join-Path $ExistingRelease 'src\index.js'
 $ExistingArguments='"'+$ExistingEntry+'" --config "'+$TerminalConfig+'"'
 if (([IO.Path]::GetFileName($ExistingNode)) -ine 'node.exe' -or $ExistingTask.Actions[0].Arguments -ine $ExistingArguments -or $ExistingTask.Actions[0].WorkingDirectory -ine $ExistingRelease) { throw 'Another program owns the tablet task name.' }
 if ($TerminalManagedSetup) {
  if ((Split-Path -Parent $ExistingRelease) -ine (Join-Path $TerminalRoot 'releases') -or
      (Split-Path -Leaf $ExistingRelease) -cnotmatch '\A[0-9a-f]{64}\z' -or $ExistingTask.Principal.LogonType -ne 'ServiceAccount') {
   throw 'The existing tablet task does not use the protected release layout.'
  }
  if ($ExistingTask.State -eq 'Disabled') { throw 'The existing protected tablet task is disabled.' }
 }
}
# Reviewed application assets are embedded, not loaded as SYSTEM from Downloads.
$TerminalPayload=[Convert]::FromBase64String('__PAYLOAD_BASE64__')
$TerminalHash=[Security.Cryptography.SHA256]::Create()
try { $TerminalActualHash=[BitConverter]::ToString($TerminalHash.ComputeHash($TerminalPayload)).Replace('-','').ToLowerInvariant() } finally { $TerminalHash.Dispose() }
if ($TerminalActualHash -ne '__PAYLOAD_SHA256__') { throw 'Tablet package integrity checking failed.' }
$TerminalRelease=Assert-TerminalPath (Join-Path $TerminalRoot ('releases\'+$TerminalActualHash))
$TerminalNode=Join-Path $TerminalRelease 'node.exe'
$TerminalEntry=Join-Path $TerminalRelease 'src\index.js'
Add-Type -AssemblyName System.IO.Compression
$TerminalInput=[IO.MemoryStream]::new($TerminalPayload)
$TerminalGzip=[IO.Compression.GZipStream]::new($TerminalInput,[IO.Compression.CompressionMode]::Decompress)
$TerminalReader=[IO.StreamReader]::new($TerminalGzip,[Text.UTF8Encoding]::new($false))
try { $TerminalPackage=$TerminalReader.ReadToEnd() | ConvertFrom-Json } finally { $TerminalReader.Dispose();$TerminalGzip.Dispose();$TerminalInput.Dispose() }
$TerminalAllowedFiles=@('package.json','src/protocol.js','src/windows-key.js','src/device.js','src/broker.js','src/index.js','windows/terminal-key.ps1')
if ($TerminalPackage.schemaVersion -ne 1 -or $TerminalPackage.files.Count -ne $TerminalAllowedFiles.Count -or @($TerminalPackage.files.name | Sort-Object -Unique).Count -ne $TerminalAllowedFiles.Count) { throw 'Invalid tablet asset manifest.' }
$ReuseManagedRelease=$TerminalManagedSetup -and $ExistingTask -and $ExistingNode -ieq $TerminalNode -and
 (Test-Path -LiteralPath $TerminalConfig -PathType Leaf) -and
 (Test-Path -LiteralPath $TerminalVar -PathType Container) -and (Test-TerminalNode $TerminalNode)
if ($ReuseManagedRelease) {
 foreach ($Asset in $TerminalPackage.files) {
  if ($Asset.name -cnotin $TerminalAllowedFiles) { throw 'Unexpected tablet asset.' }
  $AssetPath=Assert-TerminalPath (Join-Path $TerminalRelease ($Asset.name.Replace('/','\')))
  if (-not (Test-Path -LiteralPath $AssetPath -PathType Leaf) -or
      (Get-FileHash -LiteralPath $AssetPath -Algorithm SHA256).Hash -ine $Asset.sha256) { $ReuseManagedRelease=$false;break }
 }
}
if (-not $ReuseManagedRelease) {
 # Only the product-owned installed service, runtime and ACLs are written.
 Initialize-TerminalDirectory $TerminalRoot
 Initialize-TerminalDirectory (Split-Path -Parent $TerminalRelease)
 Initialize-TerminalDirectory $TerminalRelease
foreach ($Asset in $TerminalPackage.files) {
 if ($Asset.name -notin $TerminalAllowedFiles) { throw 'Unexpected tablet asset.' }
 $Destination=Assert-TerminalPath (Join-Path $TerminalRelease ($Asset.name.Replace('/','\')))
 $AssetParent=Split-Path -Parent $Destination
 if (-not (Test-Path -LiteralPath $AssetParent)) { Initialize-TerminalDirectory $AssetParent }
 $AssetBytes=[Convert]::FromBase64String($Asset.bytes)
 $AssetHash=[Security.Cryptography.SHA256]::Create()
 try { $ActualAssetHash=[BitConverter]::ToString($AssetHash.ComputeHash($AssetBytes)).Replace('-','').ToLowerInvariant() } finally { $AssetHash.Dispose() }
 if ($ActualAssetHash -ne $Asset.sha256) { throw 'Tablet asset integrity checking failed.' }
 [IO.File]::WriteAllBytes($Destination,$AssetBytes)
}
Initialize-TerminalDirectory $TerminalVar
if (-not (Test-TerminalNode $TerminalNode)) {
 $NodeCandidates=@()
 if ($NodePath) { $NodeCandidates += [IO.Path]::GetFullPath($NodePath) }
 if ($ExistingTask) { $NodeCandidates += $ExistingNode }
 $NodeCandidates += @((Join-Path $env:ProgramFiles 'nodejs\node.exe'),(Join-Path $TerminalProgramFilesX86 'nodejs\node.exe'))
 $NodeSource=$NodeCandidates | Where-Object { Test-TerminalNode $_ } | Select-Object -First 1
 $NodeStaged=Assert-TerminalPath (Join-Path $TerminalRelease ('node-'+[guid]::NewGuid().ToString('N')+'.exe'))
 try {
  if ($NodeSource) { Copy-Item -LiteralPath $NodeSource -Destination $NodeStaged -Force }
  else {
   $PreviousProtocol=[Net.ServicePointManager]::SecurityProtocol
   try { [Net.ServicePointManager]::SecurityProtocol=$PreviousProtocol -bor [Net.SecurityProtocolType]::Tls12;Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v24.19.0/win-x64/node.exe' -OutFile $NodeStaged } finally { [Net.ServicePointManager]::SecurityProtocol=$PreviousProtocol }
  }
  if (-not (Test-TerminalNode $NodeStaged)) { throw 'The copied official Node.js runtime signature or version could not be verified.' }
  Move-Item -LiteralPath $NodeStaged -Destination $TerminalNode -Force
 } finally { if (Test-Path -LiteralPath $NodeStaged) { Remove-Item -LiteralPath $NodeStaged -Force } }
}
if (-not (Test-TerminalNode $TerminalNode)) { throw 'The protected runtime failed verification.' }
}
if (Test-Path -LiteralPath $TerminalConfig) { $Saved=Get-Content -LiteralPath $TerminalConfig -Raw | ConvertFrom-Json;if ($Saved.product -ne 'calai-business-terminal' -or $Saved.apiBaseUrl -ne 'https://eats.calai.info') { throw 'Another product owns this installation.' } }
$IdentityPath=Assert-TerminalPath (Join-Path $TerminalVar 'terminal-identity.json')
if ($TerminalSetup) {
 Assert-TerminalEnrolmentData -Setup $TerminalSetup -Embedded:$TerminalHasEmbeddedEnrolment
 if (Test-Path -LiteralPath $IdentityPath) { $SavedIdentity=Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json -ErrorAction Stop;Assert-TerminalSetupIdentity -Setup $TerminalSetup -SavedIdentity $SavedIdentity -Embedded:$TerminalHasEmbeddedEnrolment -ForgetRegistration:$ForgetRegistration }
}
if ($ForgetRegistration -and (Test-Path -LiteralPath $IdentityPath)) {
 # Explicit administrator reset retains recoverable public metadata.
 # A new owner-approved server pairing is still required.
 Move-Item -LiteralPath $IdentityPath -Destination ($IdentityPath+'.retired-'+[guid]::NewGuid().ToString('N')) -Force
}
if ($TerminalSetup) {
 $SetupOutput=@{terminalId=[string]$TerminalSetup.terminalId;businessId=[string]$TerminalSetup.businessId;code=[string]$TerminalSetup.code;challenge=[string]$TerminalSetup.challenge;apiBaseUrl='https://eats.calai.info';expiresAt=[string]$TerminalSetup.expiresAt}
 [IO.File]::WriteAllText((Assert-TerminalPath (Join-Path $TerminalRoot 'enrolment.json')),($SetupOutput | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
$Configuration=@{schemaVersion=1;product='calai-business-terminal';apiBaseUrl='https://eats.calai.info';port=17864;deviceName=$DeviceName}
if (-not $TerminalManagedSetup -or -not (Test-Path -LiteralPath $TerminalConfig)) {
 [IO.File]::WriteAllText((Assert-TerminalPath $TerminalConfig),($Configuration | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
$EdgeExecutable=@((Join-Path $TerminalProgramFilesX86 'Microsoft\Edge\Application\msedge.exe'),(Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $EdgeExecutable -or [Diagnostics.FileVersionInfo]::GetVersionInfo($EdgeExecutable).FileMajorPart -lt 146) { throw 'Update managed Microsoft Edge to version146 or later for scoped loopback access.' }
$EdgeLoopbackPolicy='HKLM:\SOFTWARE\Policies\Microsoft\Edge\LoopbackNetworkAllowedForUrls'
$ExistingValues=Get-ItemProperty -LiteralPath $EdgeLoopbackPolicy -ErrorAction SilentlyContinue
$OriginPresent=$ExistingValues -and @($ExistingValues.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' -and $_.Value -eq 'https://eats.calai.info' }).Count -gt 0
if (-not $OriginPresent -and -not $TerminalManagedSetup) { Write-Warning 'The browser must permit local-network access for eats.calai.info. Managed browser/Intune policy is a separate setup task; this installer does not change Windows or browser policy.' }
$Action=New-ScheduledTaskAction -Execute $TerminalNode -Argument ('"'+$TerminalEntry+'" --config "'+$TerminalConfig+'"') -WorkingDirectory $TerminalRelease
$Principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$Settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$RestartManagedBroker=$TerminalManagedSetup -and $ExpiredSetupId -and $ExistingTask -and $ExistingTask.State -eq 'Running'
if ($ExistingTask -and (-not $ReuseManagedRelease -or $RestartManagedBroker)) {
 if ($TerminalManagedSetup) {
  if ($ExistingTask.State -eq 'Running') {
   Stop-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction Stop
   $StopDeadline=[DateTimeOffset]::UtcNow.AddSeconds(5)
   do {
    $BrokerState=(Get-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction Stop).State
    if ($BrokerState -ne 'Running') { break }
    Start-Sleep -Milliseconds 200
   } while ([DateTimeOffset]::UtcNow -lt $StopDeadline)
   if ($BrokerState -eq 'Running') { throw 'The protected tablet task did not stop for its upgrade.' }
  }
 } else { Stop-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue }
}
try {
 if ($TerminalManagedSetup -and $ExpiredSetupId) {
  $ConfirmedExpiredId=Assert-TerminalManagedState $IdentityPath $ManagedPath $ManualPath $TerminalManagedSetup.jobId -CheckExpiredLegacy
  if ($ConfirmedExpiredId -cne $ExpiredSetupId) { throw 'Saved legacy tablet setup changed during preparation.' }
  $ExpiredBackup=Assert-TerminalPath (Join-Path $TerminalRoot ('enrolment.expired-'+$ExpiredSetupId+'-'+[guid]::NewGuid().ToString('N')+'.json'))
  Move-Item -LiteralPath $ManualPath -Destination $ExpiredBackup
 }
 if (-not $ReuseManagedRelease) {
  if ($TerminalManagedSetup -and $ExistingTask) {
   Set-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -Action $Action | Out-Null
  } else {
   Register-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -Action $Action -Principal $Principal -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $Settings -Description 'Protected tablet identity and automatic session broker; no printer queue consumer.' -Force | Out-Null
  }
 }
 if ($TerminalManagedSetup) {
  Assert-TerminalManagedState $IdentityPath $ManagedPath $ManualPath $TerminalManagedSetup.jobId | Out-Null
  $Evidence=@(& $TerminalNode $TerminalEntry '--config' $TerminalConfig '--prepare-managed' $TerminalManagedSetup.jobId)
  if ($LASTEXITCODE -ne 0 -or $Evidence.Count -ne 1 -or $Evidence[0] -cnotmatch '\ACAL_EATS_MANAGED_SETUP_V1:[A-Za-z0-9_-]{1,1000}\z') { throw 'The protected tablet key could not prepare managed setup evidence.' }
 }
 if (-not $ReuseManagedRelease -or $RestartManagedBroker -or $ExistingTask.State -ne 'Running') { Start-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' | Out-Null }
} catch {
 if ($ExistingTask -and (-not $ReuseManagedRelease -or $RestartManagedBroker)) {
  if ($TerminalManagedSetup -and -not $ReuseManagedRelease) { Set-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -Action $ExistingTask.Actions -ErrorAction SilentlyContinue | Out-Null }
  Start-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue | Out-Null
 }
 throw
}
if ($TerminalManagedSetup) { Write-Output $Evidence[0] }
else { Write-Output 'Protected restaurant tablet identity service installed. Original Calai printer credentials, queues and startup are preserved.' }
} finally {
 if ($InstallLockHeld) { $InstallLock.ReleaseMutex() }
 $InstallLock.Dispose()
}
