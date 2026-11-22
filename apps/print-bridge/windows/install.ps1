[CmdletBinding()]
param(
    [string]$ConfigPath = "",
    [string]$SetupPath = "",
    [string]$NodePath = "",
    [switch]$DisablePhysicalPrinting
)

$ErrorActionPreference = "Stop"
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$PrincipalCheck = New-Object Security.Principal.WindowsPrincipal($Identity)
if (-not $PrincipalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run the downloaded printer installer as Administrator. Managed tablet installation can run as SYSTEM."
}
$SourceDir = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $SourceDir "config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not $SetupPath) { $SetupPath = Join-Path (Split-Path -Parent $ConfigPath) "setup.json" }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "The downloaded printer configuration is missing." }
if (-not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) { throw "Download a fresh printer setup from Cal-Eats printer settings." }
$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Setup = Get-Content -LiteralPath $SetupPath -Raw | ConvertFrom-Json
if ($Config.product -ne "cal-eats" -or $Config.schemaVersion -ne 1 -or $Setup.product -ne "cal-eats" -or $Setup.schemaVersion -ne 1) {
    throw "This installer accepts Cal-Eats printer setup only. Other Calai software is left unchanged."
}
$UuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
if ($Setup.printerId -notmatch $UuidPattern -or $Setup.restaurantId -notmatch $UuidPattern -or -not $Setup.code -or $Setup.code.Length -lt 6 -or $Setup.code.Length -gt 200) {
    throw "The downloaded printer identity is invalid. Download a fresh printer setup."
}
$PrinterId = ([guid]$Setup.printerId).ToString()
# This installer owns Cal-Eats only. Do not patch, restart, load or reuse the
# original Calai service/runtime. Shared hardware needs a separately verified
# supported arrangement before a second producer is installed.
$ProtectedCalaiFiles = @(
    'C:\Calai\PrinterBridge\printer-bridge\print-bridge.js',
    'C:\Calai\PrinterBridge\print-bridge.js',
    (Join-Path $env:ProgramData 'CalaiPrintBridge\print-bridge.js')
)
if ($ProtectedCalaiFiles | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) {
    throw 'An existing Calai printing service was detected and left unchanged. Cal-Eats shared-printer installation is not verified for this tablet. Contact support before installing another printer connection.'
}
$TaskName = "CalEatsPrinter-$PrinterId"
$ProgramDataRoot = [IO.Path]::GetFullPath($env:ProgramData)
$PrintersRoot = [IO.Path]::GetFullPath((Join-Path $ProgramDataRoot "CalEats\Printers"))
$InstallDir = [IO.Path]::GetFullPath((Join-Path $PrintersRoot $PrinterId))

function Assert-InstallPath([string]$Target) {
    $Full = [IO.Path]::GetFullPath($Target)
    if ($Full -ne $InstallDir -and -not $Full.StartsWith($InstallDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The printer installation path is outside its assigned directory."
    }
    $Current = $Full
    while ($Current -and $Current.Length -ge $ProgramDataRoot.Length) {
        if (Test-Path -LiteralPath $Current) {
            if ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Printer setup cannot use redirected installation folders." }
        }
        $Current = Split-Path -Parent $Current
    }
    return $Full
}

[void](Assert-InstallPath $InstallDir)
$InstalledConfigPath = Assert-InstallPath (Join-Path $InstallDir "config.json")
[void](Assert-InstallPath (Join-Path $InstallDir "var"))
foreach ($StatePath in @("var\device-credential.json", "var\device-credential.json.pairing-pending.json", "var\print-journal.json", "var\print-journal.json.lock", "var\print-bridge.log", "var\print-bridge.log.1", "service-console.log", "run.cmd", "package.json")) {
    [void](Assert-InstallPath (Join-Path $InstallDir $StatePath))
}
if (Test-Path -LiteralPath $InstalledConfigPath) {
    $InstalledConfig = Get-Content -LiteralPath $InstalledConfigPath -Raw | ConvertFrom-Json
    if ($InstalledConfig.product -ne "cal-eats") { throw "The destination belongs to another product and was left unchanged." }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# Replace the ACL instead of retaining any pre-existing explicit user grants.
$ProtectedAcl = New-Object Security.AccessControl.DirectorySecurity
$ProtectedAcl.SetAccessRuleProtection($true, $false)
foreach ($Sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $IdentitySid = New-Object Security.Principal.SecurityIdentifier($Sid)
    $Rule = New-Object Security.AccessControl.FileSystemAccessRule($IdentitySid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $ProtectedAcl.AddAccessRule($Rule)
}
Set-Acl -LiteralPath $InstallDir -AclObject $ProtectedAcl

function Assert-Node24([string]$Candidate) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
    $Signature = Get-AuthenticodeSignature -LiteralPath $Candidate
    if ($Signature.Status -ne "Valid" -or $Signature.SignerCertificate.Subject -notmatch '(?i)\bOpenJS Foundation\b') { return $false }
    $Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Candidate).ProductVersion
    return $Version -match '^24\.'
}

function Get-VerifiedNode24 {
    $RuntimeDir = Assert-InstallPath (Join-Path $InstallDir "runtime")
    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    $Candidates = @()
    if ($NodePath) { $Candidates += $NodePath }
    $Found = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($Found) { $Candidates += $Found.Source }
    $Existing = Get-ChildItem -LiteralPath $RuntimeDir -Filter 'node-v24*.exe' -File -ErrorAction SilentlyContinue
    if ($Existing) { $Candidates += @($Existing | Sort-Object LastWriteTimeUtc -Descending | ForEach-Object { $_.FullName }) }
    foreach ($Candidate in $Candidates) {
        if (Assert-Node24 $Candidate) {
            $Version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Candidate).ProductVersion
            $SafeVersion = ($Version -replace '[^0-9.]', '')
            $Destination = Assert-InstallPath (Join-Path $RuntimeDir "node-v$SafeVersion.exe")
            if ([IO.Path]::GetFullPath($Candidate) -ne $Destination) { Copy-Item -LiteralPath $Candidate -Destination $Destination -Force }
            if (-not (Assert-Node24 $Destination)) { throw "The copied Node.js runtime could not be verified." }
            return $Destination
        }
    }

    # Official HTTPS release checksum plus the executable's trusted Windows
    # signature are verified before any downloaded program is executed.
    $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $Arch = switch ($Architecture.ToUpperInvariant()) { "AMD64" { "x64" } "ARM64" { "arm64" } default { throw "A supported 64-bit Windows installation is required." } }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ReleaseUrl = "https://nodejs.org/dist/latest-v24.x/"
    $Manifest = (Invoke-WebRequest -Uri ($ReleaseUrl + "SHASUMS256.txt") -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60).Content
    if ($Manifest -is [byte[]]) { $Manifest = [Text.Encoding]::UTF8.GetString($Manifest) }
    $Pattern = '(?m)^([a-fA-F0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + $Arch + '\.zip)\s*$'
    $Match = [regex]::Match([string]$Manifest, $Pattern)
    if (-not $Match.Success) { throw "The official Node.js 24 checksum could not be verified. Retry printer setup when the connection is available." }
    $ExpectedHash = $Match.Groups[1].Value
    $ArchiveName = $Match.Groups[2].Value
    $VersionName = $ArchiveName -replace '-win-(x64|arm64)\.zip$', ''
    $ArchivePath = Assert-InstallPath (Join-Path $RuntimeDir ($ArchiveName + ".download"))
    $ExecutablePath = Assert-InstallPath (Join-Path $RuntimeDir ($VersionName + ".exe"))
    try {
        Invoke-WebRequest -Uri ($ReleaseUrl + $ArchiveName) -OutFile $ArchivePath -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 300
        if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ne $ExpectedHash) { throw "The Node.js download checksum did not match. No downloaded program was executed." }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $Archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
        try {
            $Entry = $Archive.GetEntry(($ArchiveName -replace '\.zip$', '') + "/node.exe")
            if (-not $Entry -or $Entry.Length -gt 250MB) { throw "The official Node.js package is invalid." }
            $Stream = $Entry.Open()
            try {
                $Output = [IO.File]::Open($ExecutablePath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $Stream.CopyTo($Output) } finally { $Output.Dispose() }
            } finally { $Stream.Dispose() }
        } finally { $Archive.Dispose() }
        if (-not (Assert-Node24 $ExecutablePath)) { throw "The downloaded Node.js runtime does not have a valid OpenJS Foundation signature and version 24." }
        return $ExecutablePath
    } finally {
        if (Test-Path -LiteralPath $ArchivePath) { Remove-Item -LiteralPath (Assert-InstallPath $ArchivePath) -Force }
    }
}

$RuntimeNode = Get-VerifiedNode24
& $RuntimeNode (Join-Path $SourceDir "src\index.js") validate --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "The downloaded printer configuration is invalid. The running printer was left unchanged." }
$InstalledSetup = Assert-InstallPath (Join-Path $InstallDir "setup.json")
if (Test-Path -LiteralPath $InstalledSetup) {
    $PreviousSetup = Get-Content -LiteralPath $InstalledSetup -Raw | ConvertFrom-Json
    if ($PreviousSetup.product -ne "cal-eats" -or $PreviousSetup.printerId -ne $Setup.printerId -or $PreviousSetup.restaurantId -ne $Setup.restaurantId) {
        throw "The existing printer setup identity does not match. It was left unchanged."
    }
}
$CredentialFile = Assert-InstallPath (Join-Path $InstallDir "var\device-credential.json")
if (Test-Path -LiteralPath $CredentialFile) {
    $SavedCredential = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
    if ($SavedCredential.product -ne "cal-eats" -or $SavedCredential.printerId -ne $Setup.printerId -or $SavedCredential.restaurantId -ne $Setup.restaurantId) {
        throw "The saved printer connection belongs to another restaurant or product. It was left unchanged."
    }
}

# Only this printer's Cal-Eats task is updated. Original Calai tasks and
# processes are never searched, stopped or unregistered by this installer.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
Copy-Item -LiteralPath (Join-Path $SourceDir "package.json") -Destination (Join-Path $InstallDir "package.json") -Force
$SourceFiles = Join-Path $SourceDir "src"
$DestinationFiles = Assert-InstallPath (Join-Path $InstallDir "src")
New-Item -ItemType Directory -Path $DestinationFiles -Force | Out-Null
Get-ChildItem -LiteralPath $SourceFiles -File -Filter '*.js' | ForEach-Object {
    $TargetFile = Assert-InstallPath (Join-Path $DestinationFiles $_.Name)
    Copy-Item -LiteralPath $_.FullName -Destination $TargetFile -Force
}
# Credentials, pending pairing token and durable journal remain in var/.
$Config.credentialPath = "./var/device-credential.json"
$Config.journalPath = "./var/print-journal.json"
$Config.logPath = "./var/print-bridge.log"
if ($Config.transport.kind -eq "file-sink") { $Config.transport.outputDirectory = "./var/printed" }
[IO.File]::WriteAllText((Join-Path $InstallDir "config.json"), ($Config | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
[IO.File]::WriteAllText($InstalledSetup, ($Setup | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
& $RuntimeNode (Join-Path $DestinationFiles "index.js") validate --config (Join-Path $InstallDir "config.json")
if ($LASTEXITCODE -ne 0) { throw "Printer configuration validation failed. The printer was not started." }
$PhysicalArgument = if ($DisablePhysicalPrinting) { "" } else { " --allow-physical-transport" }
$Runner = @"
@echo off
cd /d "$InstallDir"
"$RuntimeNode" "src\index.js" start --config "config.json"$PhysicalArgument >>"service-console.log" 2>&1
"@
[IO.File]::WriteAllText((Join-Path $InstallDir "run.cmd"), $Runner, [Text.Encoding]::ASCII)
$Action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\cmd.exe") -Argument ('/d /c ""' + (Join-Path $InstallDir "run.cmd") + '""') -WorkingDirectory $InstallDir
$Triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn))
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Principal $Principal -Settings $Settings -Description "Automatic Cal-Eats receipt printing for this restaurant printer." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Cal-Eats printer setup installed and started. The secure connection completes automatically; no pairing code needs to be entered. Check printer settings for connection status."
