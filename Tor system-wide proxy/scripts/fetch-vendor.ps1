# fetch-vendor.ps1 — downloads the vendored runtime binaries (Node.js + Tor)
# with SHA256 verification. These are intentionally NOT committed to git.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fetch-vendor.ps1
# Run from the project root (or anywhere — paths resolve to the script's repo).
# Safe to re-run: upgrades the vendored binaries in place.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeVersion = 'v24.22.2'
$nodeZipName = "node-$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeZipName"
$nodeSha256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'

# Tor expert bundle (Tor Browser 16.0.1, windows-x86_64).
# Older "tor-win32-*.zip" bundles are deprecated; current releases are .tar.gz.
$torVersion = '16.0.1'
$torFileName = "tor-expert-bundle-windows-x86_64-$torVersion.tar.gz"
$torUrl = "https://dist.torproject.org/torbrowser/$torVersion/$torFileName"
$torSha256 = '9eed3c3ff1fe43df034ce360196c9ec95472560d77ff55614d0cd5120edea27b'

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

    # ---------- Tor expert bundle (tar.gz) ----------
    $torTar = Join-Path $tmp 'tor.tar.gz'
    Get-VerifiedZip $torUrl $torSha256 $torTar

    $torExtract = Join-Path $tmp 'tor-extract'
    New-Item -ItemType Directory -Force $torExtract | Out-Null
    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'   # bsdtar ships with Windows 10+
    if (-not (Test-Path $tarExe)) { $tarExe = 'tar.exe' }
    & $tarExe -xzf $torTar -C $torExtract
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }

    # Clean the old bundle so no stale DLLs (e.g. OpenSSL 1.1) linger
    $torDir = Join-Path $root 'vendor\tor-bundle'
    if (Test-Path $torDir) { Remove-Item -Recurse -Force $torDir }
    New-Item -ItemType Directory -Force $torDir | Out-Null

    # Locate tor.exe regardless of the bundle's internal folder layout
    $torExe = Get-ChildItem -Path $torExtract -Recurse -Filter 'tor.exe' | Select-Object -First 1
    if (-not $torExe) { throw 'tor.exe not found in the Tor expert bundle' }
    Copy-Item (Join-Path $torExe.DirectoryName '*') $torDir -Recurse -Force

    # GeoIP data files referenced by torrc
    foreach ($name in 'geoip', 'geoip6') {
        $f = Get-ChildItem -Path $torExtract -Recurse -Filter $name -File | Select-Object -First 1
        if ($f) { Copy-Item $f.FullName (Join-Path $torDir $name) -Force }
    }
    Write-Host "  tor.exe (Tor Browser $torVersion expert bundle) + DLLs + geoip data -> $torDir"

    Write-Host ''
    Write-Host 'Vendor binaries installed. Next: npm install   (Node dependencies)'
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
