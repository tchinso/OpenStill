[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$outputDirectory = Join-Path $projectRoot 'dist'
$stagingDirectory = Join-Path $outputDirectory 'OpenStill'
$archivePath = Join-Path $outputDirectory 'OpenStill-chrome-store.zip'
$rootPrefix = $projectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$stagingFullPath = [System.IO.Path]::GetFullPath($stagingDirectory)

if (-not $stagingFullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to modify a staging path outside this project.'
}

$extensionFiles = @(
  'manifest.json',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'service-worker.js',
  'selector-engine.js',
  'picker.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'dashboard.html',
  'dashboard.css',
  'dashboard.js'
)

foreach ($relativePath in $extensionFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
    throw "Required extension file is missing: $relativePath"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'icons') -PathType Container)) {
  throw 'Required icons directory is missing.'
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
if (Test-Path -LiteralPath $stagingDirectory) {
  Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stagingDirectory | Out-Null

foreach ($relativePath in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $relativePath) -Destination (Join-Path $stagingDirectory $relativePath)
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'icons') -Destination (Join-Path $stagingDirectory 'icons') -Recurse

if (Test-Path -LiteralPath $archivePath) {
  Remove-Item -LiteralPath $archivePath -Force
}
Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stagingDirectory -Force | Select-Object -ExpandProperty FullName) -DestinationPath $archivePath -CompressionLevel Optimal

Write-Output "Created Chrome Web Store ZIP: $archivePath"
Write-Output 'The package intentionally excludes References/, project documentation, tests, and repository metadata; required license and third-party notices are included.'
