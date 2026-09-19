<#
.SYNOPSIS
    Download and verify an OpenClaw Desktop (OPC-1) release asset.

.DESCRIPTION
    Reads ../release/manifest.json, downloads the requested asset from the GitHub
    Release, and refuses to hand it over unless the SHA256 matches the manifest.
    Downloads nothing else and installs nothing on its own.

.PARAMETER Kind
    installer (default), portable, or voice-pack.

.PARAMETER OutDir
    Where to put the file. Defaults to the current directory.

.EXAMPLE
    ./install.ps1 -Kind portable
#>
[CmdletBinding()]
param(
    [ValidateSet('installer', 'portable', 'voice-pack')]
    [string]$Kind = 'installer',
    [string]$OutDir = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $PSScriptRoot '..\release\manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "manifest.json not found at $manifestPath"
}
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

$asset = $manifest.assets | Where-Object { $_.kind -eq $Kind } | Select-Object -First 1
if (-not $asset) { throw "No asset of kind '$Kind' in the manifest." }

$url = "$($manifest.repository)/releases/download/$($manifest.releaseTag)/$($asset.name)"
$dest = Join-Path $OutDir $asset.name

$sizeMB = [math]::Round($asset.bytes / 1MB, 1)
Write-Host "Asset    : $($asset.name)"
Write-Host "Size     : $sizeMB MB"
Write-Host "Expected : $($asset.sha256)"
Write-Host "From     : $url"
Write-Host ''

if (Test-Path $dest) {
    Write-Host 'File already present, verifying existing copy...'
} else {
    Write-Host 'Downloading (this is large; no progress bar means it is still working)...'
    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    } finally {
        $ProgressPreference = $oldPref
    }
}

Write-Host 'Verifying SHA256...'
$actual = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
$expected = $asset.sha256.ToLower()

if ($actual -ne $expected) {
    Remove-Item $dest -Force
    Write-Error "CHECKSUM MISMATCH -- deleted the download.`n  expected $expected`n  actual   $actual"
    exit 1
}

Write-Host ''
Write-Host "VERIFIED  $dest" -ForegroundColor Green
Write-Host ''
Write-Host 'This build is unsigned: SmartScreen will say "More info -> Run anyway".'
if ($Kind -eq 'portable') {
    Write-Host 'Portable: first launch self-extracts and takes about 90 seconds.'
}
