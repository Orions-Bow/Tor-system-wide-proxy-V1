# fetch-vendor.ps1 — downloads the vendored runtime binaries (Node.js + Tor)
# with SHA256 verification. These are intentionally NOT committed to git.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fetch-vendor.ps1
# Run from the project root (or anywhere — paths resolve to the script's repo).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeVersion = 'v24.22.2'
$nodeZipName = "node-$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeZipName"
$nodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'

$torUrl = 'https://archive.torproject.org/tor-package-archive/torbrowser/10.0.15/tor-win32-0.4.5.7.zip'
$torSha256 = '0f3a038dc1a422c4824c57933889ea7624e4cdd05b3715fc8b310d90110dd567'

$tmp = Join-Path $env:TEMP ('tor-proxy-vendor-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-VerifiedZip($url, $sha256, $outFile) {
    Write-Host "Downloading $url ..."
    Invoke-WebRequest $url -OutFile $outFile -UseBasicParsing
    $actual = (Get-FileHash $outFile -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $sha256) {
        Remove-Item $outFile -Force
        throw "SHA256 mismatch for $url`n  expected: $sha256`n  actual:   $actual"
    }
    Write-Host '  SHA256 verified.'
}

try {
    # ---------- Node.js runtime ----------
    $nodeZip = Join-Path $tmp 'node.zip'
    Get-VerifiedZip $nodeUrl $nodeSha256 $nodeZip
    $nodeDir = Join-Path $root 'vendor\nodejs'
    New-Item -ItemType Directory -Force $nodeDir | Out-Null
    $zip = [System.IO.Compression.ZipFile]::OpenRead($nodeZip)
    $entry = $zip.Entries | Where-Object { $_.FullName -eq "node-$nodeVersion-win-x64/node.exe" }
    if (-not $entry) { throw 'node.exe not found in Node.js zip' }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeDir 'node.exe'), $true)
    $zip.Dispose()
    Write-Host "  node.exe -> $nodeDir"

    # ---------- Tor bundle ----------
    $torZip = Join-Path $tmp 'tor.zip'
    Get-VerifiedZip $torUrl $torSha256 $torZip
    $torDir = Join-Path $root 'vendor\tor-bundle'
    New-Item -ItemType Directory -Force $torDir | Out-Null
    $zip = [System.IO.Compression.ZipFile]::OpenRead($torZip)
    foreach ($e in $zip.Entries) {
        if ($e.FullName -like 'Tor/*' -and $e.Name) {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $torDir $e.Name), $true)
        }
        # GeoIP data files referenced by torrc
        if ($e.FullName -eq 'Data/Tor/geoip' -or $e.FullName -eq 'Data/Tor/geoip6') {
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $torDir $e.Name), $true)
        }
    }
    $zip.Dispose()
    Write-Host "  tor.exe + DLLs + geoip data -> $torDir"

    Write-Host ''
    Write-Host 'Vendor binaries installed. Next: npm install   (Node dependencies)'
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
