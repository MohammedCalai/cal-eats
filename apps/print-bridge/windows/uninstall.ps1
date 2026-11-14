param([Parameter(Mandatory = $true)][guid]$PrinterId)
$ErrorActionPreference = "Stop"
$TaskName = "CalEatsPrinter-$($PrinterId.ToString())"
$PrintersRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData "CalEats\Printers"))
$InstallDir = [IO.Path]::GetFullPath((Join-Path $PrintersRoot $PrinterId.ToString()))
if (-not $InstallDir.StartsWith($PrintersRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The printer removal path is outside the Cal-Eats printer directory."
}
$Current = $InstallDir
while ($Current -and $Current.Length -ge ([IO.Path]::GetFullPath($env:ProgramData)).Length) {
    if ((Test-Path -LiteralPath $Current) -and ((Get-Item -LiteralPath $Current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Printer removal cannot follow redirected folders."
    }
    $Current = Split-Path -Parent $Current
}
if (Test-Path -LiteralPath $InstallDir) {
    # Refuse redirected descendants before the recursive delete as well.
    $Redirected = Get-ChildItem -LiteralPath $InstallDir -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
    if ($Redirected) { throw "Printer removal found a redirected folder and stopped." }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
Write-Host "Removed this Cal-Eats printer connection only. Original Calai software and other printers were left unchanged."
