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
    $Config.credentialPath = './var/device-credential.json'
    $Config.journalPath = './var/print-journal.json'
    $Config.logPath = './var/print-bridge.log'
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
