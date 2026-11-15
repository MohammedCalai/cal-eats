[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $Raw = [Console]::In.ReadToEnd()
    if ($Raw.Length -gt 524288) { throw 'Request too large' }
    $Request = $Raw | ConvertFrom-Json
    if ($Request.printerName -isnot [string] -or $Request.printerName.Length -lt 1 -or $Request.printerName.Length -gt 200 -or $Request.printerName -match '[\x00-\x1f]') { throw 'A configured Windows printer name is required' }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CalEatsSpooler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct PRINTER_INFO_2 {
    public string ServerName, PrinterName, ShareName, PortName, DriverName, Comment, Location;
    public IntPtr DevMode; public string SepFile, PrintProcessor, Datatype, Parameters;
    public IntPtr SecurityDescriptor; public uint Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, Jobs, AveragePpm;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string Name; public string OutputFile; public string Datatype = "RAW"; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool GetPrinter(IntPtr handle, uint level, IntPtr data, uint size, out uint needed);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint StartDocPrinter(IntPtr handle, uint level, [In] DOC_INFO_1 info);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, uint count, out uint written);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
}
'@
    $Handle = [IntPtr]::Zero
    if (-not [CalEatsSpooler]::OpenPrinter($Request.printerName, [ref]$Handle, [IntPtr]::Zero)) { throw 'Printer unavailable' }
    try {
        if ($Request.action -eq 'inspect') {
            [uint32]$Needed = 0
            [void][CalEatsSpooler]::GetPrinter($Handle, 2, [IntPtr]::Zero, 0, [ref]$Needed)
            if ($Needed -lt 1 -or $Needed -gt 1048576) { throw 'Printer status unavailable' }
            $Memory = [Runtime.InteropServices.Marshal]::AllocHGlobal([int]$Needed)
            try {
                if (-not [CalEatsSpooler]::GetPrinter($Handle, 2, $Memory, $Needed, [ref]$Needed)) { throw 'Printer status unavailable' }
                $Info = [Runtime.InteropServices.Marshal]::PtrToStructure($Memory, [type][CalEatsSpooler+PRINTER_INFO_2])
                $Result = @{ installed = $true; statusBits = [uint32]$Info.Status; queuedJobs = [uint32]$Info.Jobs; source = 'windows-spooler'; hardwareReadinessKnown = $false; physicalPrinted = $false }
            } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($Memory) }
        } elseif ($Request.action -eq 'submit') {
            $Bytes = [Convert]::FromBase64String($Request.payloadBase64)
            if ($Bytes.Length -lt 1 -or $Bytes.Length -gt 262144 -or $Request.documentName -notmatch '^Cal-Eats-[A-Za-z0-9_-]{8,100}-[0-9]{1,4}$') { throw 'Invalid receipt submission' }
            $Document = [CalEatsSpooler+DOC_INFO_1]::new()
            $Document.Name = $Request.documentName
            $JobId = [CalEatsSpooler]::StartDocPrinter($Handle, 1, $Document)
            if ($JobId -eq 0) { throw 'Spooler did not accept the receipt' }
            # After StartDocPrinter the job may already have escaped to a device.
            # Never auto-resubmit on a later error, lost response or restart.
            $Accepted = $false
            try {
                [uint32]$Written = 0
                $Started = [CalEatsSpooler]::StartPagePrinter($Handle)
                $Accepted = $Started -and [CalEatsSpooler]::WritePrinter($Handle, $Bytes, $Bytes.Length, [ref]$Written) -and $Written -eq $Bytes.Length
                if ($Started) { $Accepted = [CalEatsSpooler]::EndPagePrinter($Handle) -and $Accepted }
                $Accepted = [CalEatsSpooler]::EndDocPrinter($Handle) -and $Accepted
            } catch { $Accepted = $false }
            $Result = @{ spoolerJobId = [string]$JobId; outcome = $(if ($Accepted) { 'submitted' } else { 'uncertain' }); physicalPrinted = $false; source = 'windows-spooler' }
        } else { throw 'Unsupported printer operation' }
        [Console]::Out.Write(($Result | ConvertTo-Json -Compress))
    } finally { if ($Handle -ne [IntPtr]::Zero) { [void][CalEatsSpooler]::ClosePrinter($Handle) } }
} catch {
    [Console]::Error.Write('Windows printer operation failed; no physical paper result can be confirmed.')
    exit 1
}
