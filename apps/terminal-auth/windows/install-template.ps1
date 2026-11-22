[CmdletBinding()]
param([string]$NodePath='',[string]$DeviceName='Restaurant tablet',[string]$EnrolmentPath='',[string]$TargetSerial='',[switch]$ForgetRegistration)
$ErrorActionPreference='Stop'
if (-not [Environment]::Is64BitProcess) { throw 'Use 64-bit Windows PowerShell.' }
$TerminalIdentity=[Security.Principal.WindowsIdentity]::GetCurrent()
$TerminalPrincipal=New-Object Security.Principal.WindowsPrincipal($TerminalIdentity)
if (-not $TerminalPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Managed administrator setup is required.' }
if ($TargetSerial -and ([string](Get-CimInstance Win32_BIOS).SerialNumber).Trim() -ne $TargetSerial) { return }
if ($DeviceName.Length -lt 2 -or $DeviceName.Length -gt 80 -or $DeviceName -match '[\r\n\0]') { throw 'Invalid tablet name.' }
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
function Set-TerminalProtection([string]$Path) {
 $Acl=New-Object Security.AccessControl.DirectorySecurity
 $Acl.SetAccessRuleProtection($true,$false);$Acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
 foreach ($Sid in @('S-1-5-18','S-1-5-32-544')) { $Acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }
 Set-Acl -LiteralPath $Path -AclObject $Acl
}
function Test-TerminalNode([string]$Path) {
 if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
 if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
 $Signature=Get-AuthenticodeSignature -LiteralPath $Path
 if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch '(?i)\bOpenJS Foundation\b') { return $false }
 return [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion -match '^24\.(?:19|[2-9][0-9]|[1-9][0-9]{2,})\.'
}
Assert-TerminalPath $TerminalRoot | Out-Null
if (-not (Test-Path -LiteralPath $TerminalParent -PathType Container) -or ((Get-Item -LiteralPath $TerminalParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The Windows application-data directory is unavailable or redirected.' }
# This standalone Cal-Eats installation does not require or modify a Calai
# management folder. ProgramData permits ordinary users to create directories;
# only the new product-owned child is given a restrictive ACL below.
if (Test-Path -LiteralPath $TerminalRoot) {
 $ExistingAcl=Get-Acl -LiteralPath $TerminalRoot
 $ExistingOwner=([Security.Principal.NTAccount]::new($ExistingAcl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
 if ($ExistingOwner -notin @('S-1-5-18','S-1-5-32-544')) { throw 'The existing tablet folder has an untrusted owner.' }
 foreach ($Rule in $ExistingAcl.Access) {
  $Sid=$Rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  $WriteBits=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  if ($Rule.AccessControlType -eq 'Allow' -and ($Rule.FileSystemRights -band $WriteBits) -ne 0 -and $Sid -notin @('S-1-5-18','S-1-5-32-544','S-1-3-0')) { throw 'The existing tablet folder is user-writable.' }
 }
} else { New-Item -ItemType Directory -Path $TerminalRoot -Force | Out-Null }
Set-TerminalProtection $TerminalRoot
if (Test-Path -LiteralPath $TerminalConfig) { Assert-TerminalPath $TerminalConfig | Out-Null;$Saved=Get-Content -LiteralPath $TerminalConfig -Raw | ConvertFrom-Json;if ($Saved.product -ne 'calai-business-terminal' -or $Saved.apiBaseUrl -ne 'https://eats.calai.info') { throw 'Another product owns this installation.' } }
$ExistingTask=Get-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($ExistingTask) {
 if ($ExistingTask.Actions.Count -ne 1 -or $ExistingTask.Principal.UserId -notin @('SYSTEM','S-1-5-18')) { throw 'Another program owns the tablet task name.' }
 $ExistingNode=Assert-TerminalPath $ExistingTask.Actions[0].Execute
 $ExistingRelease=Split-Path -Parent $ExistingNode
 $ExistingEntry=Join-Path $ExistingRelease 'src\index.js'
 $ExistingArguments='"'+$ExistingEntry+'" --config "'+$TerminalConfig+'"'
 if (([IO.Path]::GetFileName($ExistingNode)) -ine 'node.exe' -or $ExistingTask.Actions[0].Arguments -ine $ExistingArguments -or $ExistingTask.Actions[0].WorkingDirectory -ine $ExistingRelease) { throw 'Another program owns the tablet task name.' }
}
# Reviewed application assets are embedded, not loaded as SYSTEM from Downloads.
$TerminalPayload=[Convert]::FromBase64String('__PAYLOAD_BASE64__')
$TerminalHash=[Security.Cryptography.SHA256]::Create()
try { $TerminalActualHash=[BitConverter]::ToString($TerminalHash.ComputeHash($TerminalPayload)).Replace('-','').ToLowerInvariant() } finally { $TerminalHash.Dispose() }
if ($TerminalActualHash -ne '__PAYLOAD_SHA256__') { throw 'Tablet package integrity checking failed.' }
$TerminalRelease=Assert-TerminalPath (Join-Path $TerminalRoot ('releases\'+$TerminalActualHash))
New-Item -ItemType Directory -Path $TerminalRelease -Force | Out-Null
Set-TerminalProtection $TerminalRelease
$TerminalNode=Join-Path $TerminalRelease 'node.exe'
$TerminalEntry=Join-Path $TerminalRelease 'src\index.js'
Add-Type -AssemblyName System.IO.Compression
$TerminalInput=[IO.MemoryStream]::new($TerminalPayload)
$TerminalGzip=[IO.Compression.GZipStream]::new($TerminalInput,[IO.Compression.CompressionMode]::Decompress)
$TerminalReader=[IO.StreamReader]::new($TerminalGzip,[Text.UTF8Encoding]::new($false))
try { $TerminalPackage=$TerminalReader.ReadToEnd() | ConvertFrom-Json } finally { $TerminalReader.Dispose();$TerminalGzip.Dispose();$TerminalInput.Dispose() }
$TerminalAllowedFiles=@('package.json','src/protocol.js','src/windows-key.js','src/device.js','src/broker.js','src/index.js','windows/terminal-key.ps1')
if ($TerminalPackage.schemaVersion -ne 1 -or $TerminalPackage.files.Count -ne $TerminalAllowedFiles.Count -or @($TerminalPackage.files.name | Sort-Object -Unique).Count -ne $TerminalAllowedFiles.Count) { throw 'Invalid tablet asset manifest.' }
foreach ($Asset in $TerminalPackage.files) {
 if ($Asset.name -notin $TerminalAllowedFiles) { throw 'Unexpected tablet asset.' }
 $Destination=Assert-TerminalPath (Join-Path $TerminalRelease ($Asset.name.Replace('/','\')))
 New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
 $AssetBytes=[Convert]::FromBase64String($Asset.bytes)
 $AssetHash=[Security.Cryptography.SHA256]::Create()
 try { $ActualAssetHash=[BitConverter]::ToString($AssetHash.ComputeHash($AssetBytes)).Replace('-','').ToLowerInvariant() } finally { $AssetHash.Dispose() }
 if ($ActualAssetHash -ne $Asset.sha256) { throw 'Tablet asset integrity checking failed.' }
 [IO.File]::WriteAllBytes($Destination,$AssetBytes)
}
New-Item -ItemType Directory -Path (Assert-TerminalPath $TerminalVar) -Force | Out-Null
Set-TerminalProtection $TerminalVar
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
if (Test-Path -LiteralPath $TerminalConfig) { $Saved=Get-Content -LiteralPath $TerminalConfig -Raw | ConvertFrom-Json;if ($Saved.product -ne 'calai-business-terminal' -or $Saved.apiBaseUrl -ne 'https://eats.calai.info') { throw 'Another product owns this installation.' } }
$IdentityPath=Assert-TerminalPath (Join-Path $TerminalVar 'terminal-identity.json')
if ($ForgetRegistration -and (Test-Path -LiteralPath $IdentityPath)) {
 # Explicit administrator reset retains recoverable public metadata.
 # A new owner-approved server pairing is still required.
 Move-Item -LiteralPath $IdentityPath -Destination ($IdentityPath+'.retired-'+[guid]::NewGuid().ToString('N')) -Force
}
if ($EnrolmentPath) {
 $Setup=Get-Content -LiteralPath $EnrolmentPath -Raw | ConvertFrom-Json
 $Uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 if ($Setup.terminalId -notmatch $Uuid -or $Setup.businessId -notmatch $Uuid -or $Setup.code -notmatch '^[A-Za-z0-9_-]{8,200}$' -or $Setup.challenge -notmatch '^[A-Za-z0-9_-]{20,300}$' -or $Setup.apiBaseUrl -ne 'https://eats.calai.info' -or [DateTimeOffset]::Parse($Setup.expiresAt) -le [DateTimeOffset]::UtcNow) { throw 'Owner-approved tablet enrolment is invalid or expired.' }
 if (Test-Path -LiteralPath $IdentityPath) { $SavedIdentity=Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json;if ($SavedIdentity.terminalId -ne $Setup.terminalId -or ($SavedIdentity.paired -and $SavedIdentity.businessId -ne $Setup.businessId)) { throw 'This tablet has a different registration. Use explicit owner replacement.' } }
 $SetupOutput=@{terminalId=[string]$Setup.terminalId;businessId=[string]$Setup.businessId;code=[string]$Setup.code;challenge=[string]$Setup.challenge;apiBaseUrl='https://eats.calai.info';expiresAt=[string]$Setup.expiresAt}
 [IO.File]::WriteAllText((Assert-TerminalPath (Join-Path $TerminalRoot 'enrolment.json')),($SetupOutput | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
$Configuration=@{schemaVersion=1;product='calai-business-terminal';apiBaseUrl='https://eats.calai.info';port=17864;deviceName=$DeviceName}
[IO.File]::WriteAllText((Assert-TerminalPath $TerminalConfig),($Configuration | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$EdgeExecutable=@((Join-Path $TerminalProgramFilesX86 'Microsoft\Edge\Application\msedge.exe'),(Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $EdgeExecutable -or [Diagnostics.FileVersionInfo]::GetVersionInfo($EdgeExecutable).FileMajorPart -lt 146) { throw 'Update managed Microsoft Edge to version146 or later for scoped loopback access.' }
$EdgeLoopbackPolicy='HKLM:\SOFTWARE\Policies\Microsoft\Edge\LoopbackNetworkAllowedForUrls'
$ExistingValues=Get-ItemProperty -LiteralPath $EdgeLoopbackPolicy -ErrorAction SilentlyContinue
$OriginPresent=$ExistingValues -and @($ExistingValues.PSObject.Properties | Where-Object { $_.Name -match '^\d+$' -and $_.Value -eq 'https://eats.calai.info' }).Count -gt 0
if (-not $OriginPresent) { Write-Warning 'The browser must permit local-network access for eats.calai.info. Managed browser/Intune policy is a separate setup task; this installer does not change Windows or browser policy.' }
$Action=New-ScheduledTaskAction -Execute $TerminalNode -Argument ('"'+$TerminalEntry+'" --config "'+$TerminalConfig+'"') -WorkingDirectory $TerminalRelease
$Principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$Settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
if ($ExistingTask) { Stop-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue }
try {
 Register-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -Action $Action -Principal $Principal -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $Settings -Description 'Protected tablet identity and automatic session broker; no printer queue consumer.' -Force | Out-Null
 Start-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\'
} catch {
 if ($ExistingTask) { Start-ScheduledTask -TaskName $TerminalTaskName -TaskPath '\' -ErrorAction SilentlyContinue }
 throw
}
Write-Output 'Protected restaurant tablet identity service installed. Original Calai printer credentials, queues and startup are preserved.'
