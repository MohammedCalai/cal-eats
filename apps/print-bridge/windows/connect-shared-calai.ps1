[CmdletBinding()]
param([string]$ConfigPath, [string]$SetupPath, [string]$CalaiBridgePath = '', [string]$NodePath = '', [string]$SearchDownloadsPath = '')
$ErrorActionPreference = 'Stop'
$SourceDir = Split-Path -Parent $PSScriptRoot
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Setup = Get-Content -LiteralPath $SetupPath -Raw | ConvertFrom-Json
if ($Config.product -ne 'cal-eats' -or $Setup.product -ne 'cal-eats' -or $Config.apiBaseUrl -ne 'https://eats.calai.info') { throw 'The Cal-Eats printer setup identity is invalid.' }
if ($Config.transport.kind -ne 'tcp-escpos') { return $false }
$Candidates = @('C:\Calai\PrinterBridge\printer-bridge\print-bridge.js', 'C:\Calai\PrinterBridge\print-bridge.js', 'C:\ProgramData\CalaiPrintBridge\print-bridge.js')
if ($SearchDownloadsPath -and (Test-Path -LiteralPath $SearchDownloadsPath -PathType Container)) {
    $Candidates += @(Get-ChildItem -LiteralPath $SearchDownloadsPath -Directory -Filter 'printer-bridge*' | ForEach-Object { Join-Path $_.FullName 'print-bridge.js' })
}
if ($CalaiBridgePath) { $Candidates = @([IO.Path]::GetFullPath($CalaiBridgePath)) }
$SharedCandidates = @()
foreach ($Candidate in $Candidates) {
    $Directory = Split-Path -Parent $Candidate
    $NativeConfigPath = Join-Path $Directory 'config.json'
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf) -or -not (Test-Path -LiteralPath $NativeConfigPath -PathType Leaf)) { continue }
    $Native = Get-Content -LiteralPath $NativeConfigPath -Raw | ConvertFrom-Json
    $HasNativeIdentity = ($Native.PRINTER_TOKEN -and $Native.PRINTER_TOKEN -ne 'PASTE_YOUR_PRINTER_TOKEN_HERE') -or $Native.PRINTER_MAC
    if ($HasNativeIdentity -and $Native.PRINTER_TYPE -eq 'NETWORK' -and $Native.PRINTER_IP -and [int]$Native.PRINTER_PORT -gt 0 -and $Native.BACKEND_URL -match '^https://(api\.)?calai\.info/api/?$') { $SharedCandidates += $Candidate }
}
if ($SharedCandidates.Count -eq 0) { return $false }
if ($SharedCandidates.Count -ne 1) { throw 'Multiple matching Calai bridges exist. Select the running bridge explicitly; nothing was changed.' }
$NativePath = $SharedCandidates[0]
$NativeDir = Split-Path -Parent $NativePath
# A machine CNG key must never be used by new privileged code loaded from a
# user-writable native installation. Do not alter the existing Calai runner or
# elevate it; require its existing trusted SYSTEM deployment instead.
$MachineIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$MachinePrincipal = [Security.Principal.WindowsPrincipal]::new($MachineIdentity)
if ($MachineIdentity.User.Value -ne 'S-1-5-18' -and -not $MachinePrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Secure Cal-Eats setup requires an administrator. The working Calai installation was left unchanged.' }
$CheckDirectory = [IO.Path]::GetFullPath($NativeDir)
while ($CheckDirectory) {
    $Acl = Get-Acl -LiteralPath $CheckDirectory
    $OwnerSid = ([Security.Principal.NTAccount]::new($Acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($OwnerSid -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'The native Calai folder has an untrusted owner. Use the protected SYSTEM-managed installation; the existing program was left unchanged.' }
    foreach ($AccessRule in $Acl.Access) {
        $Sid = $AccessRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        $WriteBits = [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
        if ($CheckDirectory -eq [IO.Path]::GetFullPath($NativeDir)) { $WriteBits = $WriteBits -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete }
        if ($AccessRule.AccessControlType -eq 'Allow' -and ($AccessRule.FileSystemRights -band $WriteBits) -ne 0 -and $Sid -notin @('S-1-5-18','S-1-5-32-544','S-1-3-0','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'Secure Cal-Eats requires the protected, SYSTEM-managed Calai installation. A user-writable native folder cannot hold the terminal service. The working Calai installation was left unchanged.' }
    }
    $ParentDirectory = Split-Path -Parent $CheckDirectory
    if (-not $ParentDirectory -or $ParentDirectory -eq $CheckDirectory) { break }
    $CheckDirectory = $ParentDirectory
}
$NativeAcl = Get-Acl -LiteralPath $NativePath
$NativeOwnerSid = ([Security.Principal.NTAccount]::new($NativeAcl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
if ($NativeOwnerSid -notin @('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'The native Calai program has an untrusted owner. Use the protected SYSTEM-managed installation; the existing program was left unchanged.' }
foreach ($AccessRule in $NativeAcl.Access) {
    $Sid = $AccessRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    $WriteBits = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($AccessRule.AccessControlType -eq 'Allow' -and ($AccessRule.FileSystemRights -band $WriteBits) -ne 0 -and $Sid -notin @('S-1-5-18','S-1-5-32-544','S-1-3-0','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { throw 'The native Calai program is user-writable. Install the protected managed copy before enrolling Cal-Eats. The existing Calai program was left unchanged.' }
}
$Native = Get-Content -LiteralPath (Join-Path $NativeDir 'config.json') -Raw | ConvertFrom-Json
$Config.transport.host = $Native.PRINTER_IP
$Config.transport.port = [int]$Native.PRINTER_PORT
$NodeCandidates = @((Join-Path $NativeDir 'node.exe'), (Join-Path (Split-Path -Parent $NativeDir) 'node.exe'))
if ($NodePath) { $NodeCandidates = @([IO.Path]::GetFullPath($NodePath)) }
$Node = $NodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $Node) { $FoundNode = Get-Command node.exe -ErrorAction SilentlyContinue; if ($FoundNode) { $Node = $FoundNode.Source } }
if (-not $Node) { throw 'The existing Calai Node.js runtime was not found. The working bridge was left unchanged.' }
$Signature = Get-AuthenticodeSignature -LiteralPath $Node
if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch '(?i)OpenJS Foundation') { throw 'The existing runtime signature could not be verified.' }
$Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Node).ProductVersion
if ($Version -notmatch '^(\d+)\.' -or [int]$Matches[1] -lt 20) { throw 'The existing Calai runtime must be Node.js 20 or later. It was not replaced.' }
# A pre-existing standalone Cal-Eats service must be migrated deliberately,
# otherwise two independent processes could race to claim the same printer.
if (Get-ScheduledTask -TaskName ('CalEatsPrinter-' + $Setup.printerId) -ErrorAction SilentlyContinue) { throw 'A separate Cal-Eats printer task already exists. Migrate it before connecting the shared bridge.' }
$SharedRoot = Join-Path $NativeDir 'cal-eats'
$RuntimeRoot = Join-Path $SharedRoot 'runtime'
foreach ($Target in @($NativeDir, $NativePath, (Join-Path $NativeDir 'config.json'), $SharedRoot, $RuntimeRoot, (Join-Path $RuntimeRoot 'src'), (Join-Path $SharedRoot 'var'), (Join-Path $SharedRoot 'config.json'), (Join-Path $SharedRoot 'setup.json'), (Join-Path $RuntimeRoot 'package.json'))) {
    if ((Test-Path -LiteralPath $Target) -and ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirected bridge paths are not supported.' }
}
# Validate existing scope before copying any module or changing its ACL.
foreach ($ExistingIdentityFile in @((Join-Path $SharedRoot 'setup.json'), (Join-Path $SharedRoot 'var\device-credential.json'))) {
    if (Test-Path -LiteralPath $ExistingIdentityFile) {
        $SavedIdentity = Get-Content -LiteralPath $ExistingIdentityFile -Raw | ConvertFrom-Json
        if ($SavedIdentity.product -ne 'cal-eats' -or $SavedIdentity.printerId -ne $Setup.printerId -or $SavedIdentity.restaurantId -ne $Setup.restaurantId) { throw 'The shared Cal-Eats connection belongs to another printer. Nothing was replaced.' }
    }
}
if (Test-Path -LiteralPath (Join-Path $SharedRoot 'config.json')) {
    $SavedConfiguration = Get-Content -LiteralPath (Join-Path $SharedRoot 'config.json') -Raw | ConvertFrom-Json
    if ($SavedConfiguration.product -ne 'cal-eats' -or $SavedConfiguration.apiBaseUrl -ne 'https://eats.calai.info') { throw 'The shared configuration belongs to another product. Nothing was replaced.' }
}
New-Item -ItemType Directory -Path $SharedRoot -Force | Out-Null
$ProtectedSharedAcl = [Security.AccessControl.DirectorySecurity]::new()
$ProtectedSharedAcl.SetAccessRuleProtection($true, $false)
$ProtectedSharedAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($Sid in @('S-1-5-18','S-1-5-32-544')) { $ProtectedSharedAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($Sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
$ExistingDescendants = @(Get-ChildItem -LiteralPath $SharedRoot -Recurse -Force)
foreach ($Descendant in $ExistingDescendants) { if ($Descendant.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A redirected shared file was found. Nothing was replaced.' } }
Set-Acl -LiteralPath $SharedRoot -AclObject $ProtectedSharedAcl
foreach ($Descendant in $ExistingDescendants) {
    $ItemAcl = Get-Acl -LiteralPath $Descendant.FullName
    $ItemAcl.SetAccessRuleProtection($false, $false)
    foreach ($Explicit in @($ItemAcl.Access | Where-Object { -not $_.IsInherited })) { [void]$ItemAcl.RemoveAccessRuleSpecific($Explicit) }
    $ItemAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    Set-Acl -LiteralPath $Descendant.FullName -AclObject $ItemAcl
}
$Staged = Join-Path $NativeDir ('print-bridge.' + [guid]::NewGuid().ToString('N') + '.staged.js')
try {
    # Treat user-owned native files only as data. In particular, the managed
    # SYSTEM installer never executes Node or JS from a user-writable folder.
    $NativeText = [IO.File]::ReadAllText($NativePath)
    if (-not $NativeText.StartsWith("// Cal-Eats shared Calai bridge v1`n")) {
        $AllowedHashes = Get-Content -LiteralPath (Join-Path $SourceDir 'calai-native\supported-hashes.json') -Raw | ConvertFrom-Json
        if ($AllowedHashes -notcontains (Get-FileHash -LiteralPath $NativePath -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'This native Calai bridge version has not been reviewed. It was left unchanged.' }
        $OriginalDeclaration = 'function sendToNetworkPrinter(ip, port, textContent) {'
        if (($NativeText.Split(@($OriginalDeclaration), [StringSplitOptions]::None)).Count -ne 2) { throw 'The native printer routine was not recognized.' }
        $Prefix = [IO.File]::ReadAllText((Join-Path $SourceDir 'calai-native\shared-prefix.txt')).Replace("`r`n", "`n")
        $Suffix = [IO.File]::ReadAllText((Join-Path $SourceDir 'calai-native\shared-suffix.txt')).Replace("`r`n", "`n")
        $NativeText = $Prefix + $NativeText.Replace($OriginalDeclaration, 'function calaiOriginalNetworkPrinter(ip, port, textContent) {') + $Suffix
    }
    [IO.File]::WriteAllText($Staged, $NativeText, [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot 'src') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceDir 'package.json') -Destination (Join-Path $RuntimeRoot 'package.json') -Force
    Get-ChildItem -LiteralPath (Join-Path $SourceDir 'src') -Filter '*.js' -File | ForEach-Object {
        $ModuleDestination = Join-Path $RuntimeRoot ('src\' + $_.Name)
        if ((Test-Path -LiteralPath $ModuleDestination) -and ((Get-Item -LiteralPath $ModuleDestination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing a redirected shared module.' }
        Copy-Item -LiteralPath $_.FullName -Destination $ModuleDestination -Force
    }
    $SharedWindows = Join-Path $RuntimeRoot 'windows'
    if ((Test-Path -LiteralPath $SharedWindows) -and ((Get-Item -LiteralPath $SharedWindows -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing redirected Windows helper files.' }
    New-Item -ItemType Directory -Path $SharedWindows -Force | Out-Null
    foreach ($HelperName in @('terminal-key.ps1','printer-adapter.ps1')) {
        $HelperDestination = Join-Path $SharedWindows $HelperName
        if ((Test-Path -LiteralPath $HelperDestination) -and ((Get-Item -LiteralPath $HelperDestination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing redirected Windows helper files.' }
        Copy-Item -LiteralPath (Join-Path $SourceDir ('windows\' + $HelperName)) -Destination $HelperDestination -Force
    }
    $Config.credentialPath = './var/device-credential.json'
    $Config.journalPath = './var/print-journal.json'
    $Config.logPath = './var/print-bridge.log'
    $KeyProvider = if ($SavedConfiguration -and $SavedConfiguration.terminal -and $SavedConfiguration.terminal.keyProvider -in @('software','tpm')) { $SavedConfiguration.terminal.keyProvider } else { 'software' }
    $Terminal = [pscustomobject]@{ enabled = $true; port = 17863; identityPath = './var/terminal-identity.json'; allowedOrigins = @('https://eats.calai.info'); heartbeatIntervalMs = 15000; printerId = [string]$Setup.printerId; keyProvider = $KeyProvider }
    $Config | Add-Member -NotePropertyName terminal -NotePropertyValue $Terminal -Force
    $Config.heartbeatIntervalMs = 15000
    $ExistingSetup = Join-Path $SharedRoot 'setup.json'
    $ExistingCredential = Join-Path $SharedRoot 'var\device-credential.json'
    foreach ($ExistingIdentityFile in @($ExistingSetup, $ExistingCredential)) {
        if (Test-Path -LiteralPath $ExistingIdentityFile) {
            $Saved = Get-Content -LiteralPath $ExistingIdentityFile -Raw | ConvertFrom-Json
            if ($Saved.product -ne 'cal-eats' -or $Saved.printerId -ne $Setup.printerId -or $Saved.restaurantId -ne $Setup.restaurantId) { throw 'The shared bridge belongs to another printer. No connection was replaced.' }
        }
    }
    [IO.File]::WriteAllText((Join-Path $SharedRoot 'config.json'), ($Config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($ExistingSetup, ($Setup | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $Backup = $NativePath + '.before-cal-eats'
    if (-not (Test-Path -LiteralPath $Backup)) { Copy-Item -LiteralPath $NativePath -Destination $Backup }
    Move-Item -LiteralPath $Staged -Destination $NativePath -Force
    Write-Host 'Cal-Eats is connected to the existing Calai bridge setup. Restart the Surface to load the update. The original printer configuration, runtime and startup are preserved.'
    return $true
} finally {
    if (Test-Path -LiteralPath $Staged) { Remove-Item -LiteralPath $Staged -Force }
}
