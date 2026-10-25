$TaskName = "CalEatsPrintBridge"
$InstallDir = Join-Path $env:ProgramData "CalEats\PrintBridge"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

[pscustomobject]@{
    Product = "Cal-Eats"
    TaskInstalled = $null -ne $Task
    TaskState = if ($Task) { [string]$Task.State } else { "NotInstalled" }
    FilesInstalled = Test-Path -LiteralPath (Join-Path $InstallDir "src\index.js")
    CredentialPresent = Test-Path -LiteralPath (Join-Path $InstallDir "var\device-credential.json")
    JournalPresent = Test-Path -LiteralPath (Join-Path $InstallDir "var\print-journal.json")
}
