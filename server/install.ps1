#
# install.ps1 - ea-bridge for Server (v1.3.2)
#

[CmdletBinding()]
param(
    [string]$InstallPath = 'C:\Program Files\ea-bridge',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Error "Admin rights required. Please run this script in an elevated PowerShell."
    exit 1
}

if ($Uninstall) {
    Write-Host "Uninstalling ea-bridge from $InstallPath" -ForegroundColor Yellow

    Get-Process ea-bridge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 500

    if (Test-Path $InstallPath) {
        Remove-Item $InstallPath -Recurse -Force
        Write-Host "Removed." -ForegroundColor Green
    } else {
        Write-Host "Nothing to remove."
    }
    exit 0
}

Write-Host "=== ea-bridge for Server (v1.3.2) ===" -ForegroundColor Cyan
Write-Host "Install path: $InstallPath"
Write-Host ""

$running = Get-Process ea-bridge -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping running ea-bridge instances..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

$net = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
if (-not $net -or $net.Release -lt 528040) {
    Write-Warning ".NET Framework 4.8 is required but not detected (Release < 528040)."
    Write-Warning "The bridge may fail to start. Install .NET Framework 4.8 from Microsoft."
}

$eaPath = 'C:\Program Files\Sparx Systems\EA\EA.exe'
if (-not (Test-Path $eaPath)) {
    Write-Warning "Sparx EA not found at $eaPath"
    Write-Warning "If EA is installed elsewhere, the bridge will still work but jobs won't find EA."
} else {
    Write-Host "Found EA at: $eaPath" -ForegroundColor Green
}

if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath | Out-Null
}

$here = $PSScriptRoot
Copy-Item "$here\ea-bridge.exe"        $InstallPath -Force
Copy-Item "$here\Newtonsoft.Json.dll"  $InstallPath -Force
Copy-Item "$here\ea-client.js"         $InstallPath -Force
Copy-Item "$here\README.md"            $InstallPath -Force
if (Test-Path "$here\example-spawn.js") {
    Copy-Item "$here\example-spawn.js" $InstallPath -Force
}
if (Test-Path "$here\MIGRATION.md") {
    Copy-Item "$here\MIGRATION.md"     $InstallPath -Force
}

Write-Host ""
Write-Host "Files installed:" -ForegroundColor Green
Get-ChildItem $InstallPath | Select-Object Name, Length | Format-Table -AutoSize

Write-Host ""
Write-Host "=== Post-install steps ===" -ForegroundColor Cyan
Write-Host @"

1. Use 'spawn' mode (headless EA.Repository) for service-user contexts.
   This matches the working winax pattern: new ActiveXObject('ea.Repository').

2. For a Node.js batch job:

   const { EABridge } = require('$($InstallPath.Replace('\','\\'))\\ea-client');
   const ea = new EABridge({
       exePath: '$($InstallPath.Replace('\','\\'))\\ea-bridge.exe',
       model:   'C:\\path\\to\\your-model.qea',
       mode:    'spawn',
       callTimeoutMs: 6 * 3600 * 1000,
   });
   try {
       await ea.start();
       // ... do the work via ea.repo ...
   } finally {
       await ea.close();
   }

3. Ownership safety: the bridge tracks whether it spawned EA itself or
   reused an existing EA via COM. It only kills EA instances it owns -
   long-running REST API EA processes are safe from accidental termination.

4. See MIGRATION.md for the winax -> ea-bridge mapping.

"@

Write-Host "=== Installation complete ===" -ForegroundColor Cyan
