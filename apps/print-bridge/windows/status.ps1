param([Parameter(Mandatory = $true)][guid]$PrinterId)
$ErrorActionPreference = "Stop"
$TaskName = "CalEatsPrinter-$($PrinterId.ToString())"
$InstallDir = Join-Path $env:ProgramData ("CalEats\Printers\" + $PrinterId.ToString())
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$Run = if ($Task) { Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue } else { $null }
[pscustomobject]@{
    Product = "Cal-Eats"
    PrinterId = $PrinterId.ToString()
    TaskInstalled = $null -ne $Task
    TaskState = if ($Task) { [string]$Task.State } else { "NotInstalled" }
    LastTaskResult = if ($Run) { $Run.LastTaskResult } else { $null }
    FilesInstalled = Test-Path -LiteralPath (Join-Path $InstallDir "src\index.js")
    ConnectionSaved = Test-Path -LiteralPath (Join-Path $InstallDir "var\device-credential.json")
    SetupPending = Test-Path -LiteralPath (Join-Path $InstallDir "setup.json")
    JournalPresent = Test-Path -LiteralPath (Join-Path $InstallDir "var\print-journal.json")
    TerminalIdentitySaved = Test-Path -LiteralPath (Join-Path $InstallDir "var\terminal-identity.json")
    TerminalLocalPort = 17863
    PhysicalPaperVerified = $false
}
