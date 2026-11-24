[CmdletBinding()]
param()
# Invoked only by the protected Cal-Eats SYSTEM companion. No private key is
# exported, serialized, passed on the command line or returned to the browser.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$FailureStage = 'REQUEST'
$NativeError = $null
try {
    $Raw = [Console]::In.ReadToEnd()
    if ($Raw.Length -gt 32768) { throw 'Request too large' }
    $Request = $Raw | ConvertFrom-Json
    if ($Request.terminalId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Invalid terminal identity' }
    $FailureStage = 'AUTH'
    $Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($Identity.User.Value -ne 'S-1-5-18') { throw 'The terminal key must run as SYSTEM' }
    $FailureStage = 'PROVIDER_PROBE'
    $KeyName = 'CalEats.Terminal.' + $Request.terminalId
    $Software = [Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
    $Hardware = [Security.Cryptography.CngProvider]::new('Microsoft Platform Crypto Provider')
    $Options = [Security.Cryptography.CngKeyOpenOptions]::MachineKey
    if ($Request.provider -notin @('software','tpm')) { throw 'An explicit supported key provider is required' }
    $Provider = if ($Request.provider -eq 'tpm') { $Hardware } else { $Software }
    $OtherProvider = if ($Request.provider -eq 'tpm') { $Software } else { $Hardware }
    $Key = $null
    if ([Security.Cryptography.CngKey]::Exists($KeyName, $Provider, $Options)) {
        $FailureStage = 'OPEN'
        $Key = [Security.Cryptography.CngKey]::Open($KeyName, $Provider, $Options)
    } else {
        $FailureStage = 'ALTERNATE_PROVIDER_PROBE'
        if ([Security.Cryptography.CngKey]::Exists($KeyName, $OtherProvider, $Options)) { throw 'An existing key uses a different provider. Explicit owner re-enrollment is required.' }
    }
    if (-not $Key -and $Request.action -eq 'create') {
        $FailureStage = 'CREATE'
        $Parameters = [Security.Cryptography.CngKeyCreationParameters]::new()
        $Parameters.Provider = $Provider
        $Parameters.KeyCreationOptions = [Security.Cryptography.CngKeyCreationOptions]::MachineKey
        $Parameters.ExportPolicy = [Security.Cryptography.CngExportPolicies]::None
        $Parameters.KeyUsage = [Security.Cryptography.CngKeyUsages]::Signing
        $Key = [Security.Cryptography.CngKey]::Create([Security.Cryptography.CngAlgorithm]::ECDsaP256, $KeyName, $Parameters)
    }
    if (-not $Key) { $FailureStage = 'OPEN'; throw 'Terminal key does not exist; pair this device again' }
    try {
        $FailureStage = 'POLICY'
        if (-not $Key.IsMachineKey -or $Key.ExportPolicy -ne [Security.Cryptography.CngExportPolicies]::None -or $Key.Algorithm -ne [Security.Cryptography.CngAlgorithm]::ECDsaP256 -or $Key.KeyUsage -ne [Security.Cryptography.CngKeyUsages]::Signing) { throw 'Terminal key policy is invalid' }
        # Apply a persisted protected DACL: SYSTEM and local Administrators only.
        # NCrypt security-descriptor flags are DACL_SECURITY_INFORMATION (4) and
        # NCRYPT_PERSIST_FLAG (0x80000000). No file path/key material is exposed.
        $FailureStage = 'ACL_COMPILE'
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CalEatsKeyAcl {
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
  public static extern int NCryptSetProperty(IntPtr handle, string property, byte[] value, int length, uint flags);
  [DllImport("ncrypt.dll", CharSet=CharSet.Unicode)]
  public static extern int NCryptGetProperty(IntPtr handle, string property, [Out] byte[] value, int length, out int needed, uint flags);
}
'@
        $FailureStage = 'ACL_SET'
        $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new('D:P(A;;GA;;;SY)(A;;GA;;;BA)')
        $AclBytes = New-Object byte[] $Descriptor.BinaryLength
        $Descriptor.GetBinaryForm($AclBytes, 0)
        $Result = [CalEatsKeyAcl]::NCryptSetProperty($Key.Handle.DangerousGetHandle(), 'Security Descr', $AclBytes, $AclBytes.Length, [uint32]2147483652)
        if ($Result -ne 0) { $NativeError = $Result; throw 'Terminal key ACL could not be restricted' }
        $FailureStage = 'ACL_READ'
        [int]$AclLength = 0
        $Result = [CalEatsKeyAcl]::NCryptGetProperty($Key.Handle.DangerousGetHandle(), 'Security Descr', $null, 0, [ref]$AclLength, 4)
        if ($AclLength -lt 20 -or $AclLength -gt 16384) { $NativeError = $Result; throw 'Terminal key ACL could not be read back' }
        $ActualAclBytes = New-Object byte[] $AclLength
        $Result = [CalEatsKeyAcl]::NCryptGetProperty($Key.Handle.DangerousGetHandle(), 'Security Descr', $ActualAclBytes, $ActualAclBytes.Length, [ref]$AclLength, 4)
        if ($Result -ne 0) { $NativeError = $Result; throw 'Terminal key ACL could not be read back' }
        $FailureStage = 'ACL_VERIFY'
        $ActualDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($ActualAclBytes, 0)
        if (($ActualDescriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $null -eq $ActualDescriptor.DiscretionaryAcl -or $ActualDescriptor.DiscretionaryAcl.Count -ne 2) { throw 'Terminal key DACL protection could not be verified' }
        $ActualSids = @()
        foreach ($Ace in $ActualDescriptor.DiscretionaryAcl) {
            if ($Ace -isnot [Security.AccessControl.CommonAce] -or $Ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $Ace.AccessMask -eq 0 -or $Ace.SecurityIdentifier.Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'Terminal key DACL contains an unexpected principal' }
            $ActualSids += $Ace.SecurityIdentifier.Value
        }
        if (($ActualSids | Sort-Object -Unique).Count -ne 2) { throw 'Terminal key DACL principals could not be verified' }
        $FailureStage = 'PUBLIC_EXPORT'
        $PublicBlob = $Key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
        if ($PublicBlob.Length -ne 72 -or [Text.Encoding]::ASCII.GetString($PublicBlob, 0, 4) -ne 'ECS1') { throw 'Invalid P256 public key' }
        # RFC5480 SubjectPublicKeyInfo: id-ecPublicKey + prime256v1 + X/Y.
        $Prefix = '3059301306072a8648ce3d020106082a8648ce3d03010703420004'
        $Spki = New-Object byte[] 91
        for ($Index = 0; $Index -lt 27; $Index++) { $Spki[$Index] = [Convert]::ToByte($Prefix.Substring($Index * 2, 2), 16) }
        [Array]::Copy($PublicBlob, 8, $Spki, 27, 64)
        $Output = @{ publicKeySpki = [Convert]::ToBase64String($Spki); provider = $Key.Provider.Provider; nonExportable = $true; machineKey = $true; aclVerified = $true }
        if ($Request.action -eq 'sign') {
            $FailureStage = 'SIGN'
            $Message = [Convert]::FromBase64String($Request.messageBase64)
            if ($Message.Length -lt 1 -or $Message.Length -gt 16384) { throw 'Invalid signing request' }
            $Signer = [Security.Cryptography.ECDsaCng]::new($Key)
            try { $Signature = $Signer.SignData($Message, [Security.Cryptography.HashAlgorithmName]::SHA256) } finally { $Signer.Dispose() }
            if ($Signature.Length -ne 64) { throw 'Invalid P1363 signature' }
            $Output.signature = [Convert]::ToBase64String($Signature).TrimEnd('=').Replace('+','-').Replace('/','_')
        } elseif ($Request.action -ne 'create' -and $Request.action -ne 'public') {
            $FailureStage = 'REQUEST'
            throw 'Unsupported terminal key action'
        }
        $FailureStage = 'RESPONSE'
        [Console]::Out.Write(($Output | ConvertTo-Json -Compress))
    } finally { $Key.Dispose() }
} catch {
    $Cause = $_.Exception
    while ($Cause.InnerException) { $Cause = $Cause.InnerException }
    $Code = if ($null -ne $NativeError) { $NativeError }
        elseif ($Cause -is [ComponentModel.Win32Exception]) { $Cause.NativeErrorCode }
        elseif ($Cause -isnot [Management.Automation.RuntimeException]) { $Cause.HResult }
        else { 0 }
    # Only fixed stages and numeric codes cross the installer reporting boundary.
    [Console]::Error.WriteLine(('CAL_EATS_TERMINAL_KEY_V1:TABLET_KEY_{0}:{1:X8}' -f $FailureStage, [int]$Code))
    exit 1
}
