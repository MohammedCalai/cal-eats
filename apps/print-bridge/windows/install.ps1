param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath,
    [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$TaskName = "CalEatsPrintBridge"
$InstallDir = Join-Path $env:ProgramData "CalEats\PrintBridge"
$SourceDir = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "The Cal-Eats bridge configuration file does not exist."
}

if (-not $NodePath) {
    $NodeCommand = Get-Command node -ErrorAction Stop
    $NodePath = $NodeCommand.Source
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node.js was not found. Supply an approved local NodePath; this installer never downloads runtimes."
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceDir "package.json") -Destination (Join-Path $InstallDir "package.json") -Force
Copy-Item -LiteralPath (Join-Path $SourceDir "src") -Destination $InstallDir -Recurse -Force
Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $InstallDir "config.json") -Force

$RunScript = @"
@echo off
cd /d "$InstallDir"
"$NodePath" "src\index.js" start --config "config.json" >> "service-console.log" 2>&1
"@
Set-Content -LiteralPath (Join-Path $InstallDir "run.cmd") -Value $RunScript -Encoding Ascii

& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c `"$InstallDir\run.cmd`"" -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Description "Independent Cal-Eats receipt bridge" | Out-Null

Write-Host "Cal-Eats print bridge files and startup task were installed but not started."
Write-Host "Pair the device using a short-lived code, then start only after local authorization."
