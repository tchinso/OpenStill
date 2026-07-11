[CmdletBinding()]
param(
  [string]$Python = 'python'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$dist = Join-Path $root 'dist'
$work = Join-Path $root 'build'
$spec = Join-Path $root 'spec'

& $Python -m PyInstaller --version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'PyInstaller is not available for the selected Python interpreter. Run: python -m pip install --user pyinstaller'
}

New-Item -ItemType Directory -Force -Path $dist, $work, $spec | Out-Null

$common = @(
  '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--console',
  '--distpath', $dist, '--workpath', $work, '--specpath', $spec
)

& $Python @common '--name' 'OpenStillDesktop' (Join-Path $root 'openstill_desktop.py')
if ($LASTEXITCODE -ne 0) { throw 'OpenStillDesktop onedir build failed.' }

& $Python @common '--name' 'OpenStillNativeHost' (Join-Path $root 'openstill_native_host.py')
if ($LASTEXITCODE -ne 0) { throw 'OpenStillNativeHost onedir build failed.' }

$desktopExe = Join-Path $dist 'OpenStillDesktop\OpenStillDesktop.exe'
$hostExe = Join-Path $dist 'OpenStillNativeHost\OpenStillNativeHost.exe'
if (-not (Test-Path -LiteralPath $desktopExe -PathType Leaf) -or -not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  throw 'PyInstaller reported success but an expected executable is missing.'
}

Write-Output "Built Desktop UI: $desktopExe"
Write-Output "Built Native host: $hostExe"
Write-Output 'Next: run register-native-host.ps1 with the Chrome Web Store extension ID.'
