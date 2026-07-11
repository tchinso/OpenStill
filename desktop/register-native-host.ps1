[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId,
  [string]$DistributionRoot = (Join-Path $PSScriptRoot 'dist')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hostExe = [System.IO.Path]::GetFullPath((Join-Path $DistributionRoot 'OpenStillNativeHost\OpenStillNativeHost.exe'))
if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  throw "Native host executable was not found: $hostExe. Run .\build-onedir.ps1 first."
}

$manifest = [ordered]@{
  name = 'com.openstill.desktop'
  description = 'OpenStill Desktop local Native Messaging bridge'
  path = $hostExe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path (Split-Path -Parent $hostExe) 'com.openstill.desktop.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM

$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.openstill.desktop'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

$dataRoot = $env:LOCALAPPDATA
if (-not $dataRoot) { $dataRoot = $env:APPDATA }
if (-not $dataRoot) { throw 'Could not determine a current-user AppData directory.' }
$dataDirectory = Join-Path $dataRoot 'OpenStill'
$configPath = Join-Path $dataDirectory 'desktop-config.json'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$config = [ordered]@{}
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
  $existing = Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($property in $existing.PSObject.Properties) { $config[$property.Name] = $property.Value }
}
$config['extension_id'] = $ExtensionId
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM

Write-Output "Registered native host for extension $ExtensionId"
Write-Output "Manifest: $manifestPath"
Write-Output "Native host caller verification: $configPath"
Write-Output 'Restart Chrome after registration. The manifest allows only this one extension ID.'
