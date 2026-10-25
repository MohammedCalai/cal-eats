$ErrorActionPreference = "Stop"
$TaskName = "CalEatsPrintBridge"
$InstallDir = Join-Path $env:ProgramData "CalEats\PrintBridge"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

if (Test-Path -LiteralPath $InstallDir) {
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Host "Removed only the CalEatsPrintBridge task and Cal-Eats bridge directory."
