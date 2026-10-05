#
# install.ps1 - ea-bridge for Architects (v1.3.2)
#

[CmdletBinding()]
param(
    [switch]$AddToPath,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$target = Join-Path $env:LOCALAPPDATA 'ea-bridge'

if ($Uninstall) {
    Write-Host "Uninstalling ea-bridge from $target" -ForegroundColor Yellow
    if (Test-Path $target) {
        Get-Process ea-bridge -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Milliseconds 500
        Remove-Item $target -Recurse -Force
        Write-Host "Removed." -ForegroundColor Green
    } else {
        Write-Host "Nothing to remove."
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and $userPath -like "*$target*") {
        $newPath = ($userPath -split ';' | Where-Object { $_ -ne $target }) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Removed from user PATH." -ForegroundColor Green
    }
    exit 0
}

Write-Host "=== ea-bridge for Architects (v1.3.2) ===" -ForegroundColor Cyan
Write-Host "Target: $target"
Write-Host ""

$running = Get-Process ea-bridge -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping running ea-bridge instances..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Path $target | Out-Null
}

$here = $PSScriptRoot
Copy-Item "$here\ea-bridge.exe"       $target -Force
Copy-Item "$here\Newtonsoft.Json.dll" $target -Force
Copy-Item "$here\ea-client.js"        $target -Force
Copy-Item "$here\README.md"           $target -Force
if (Test-Path "$here\example-attach.js") {
    Copy-Item "$here\example-attach.js" $target -Force
}

Write-Host "Files installed:" -ForegroundColor Green
Get-ChildItem $target | Select-Object Name, Length | Format-Table -AutoSize

if ($AddToPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$target*") {
        $newPath = if ([string]::IsNullOrEmpty($userPath)) { $target } else { "$userPath;$target" }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host ""
        Write-Host "Added to user PATH. Open a new terminal for this to take effect." -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Cyan
Write-Host "Bridge EXE:  $target\ea-bridge.exe"
Write-Host "Node client: $target\ea-client.js"
Write-Host ""
Write-Host "Quick test (with EA running and a model open):"
Write-Host "  & '$target\ea-bridge.exe' --model 'C:\path\to\your.qea' --mode attach" -ForegroundColor Gray
