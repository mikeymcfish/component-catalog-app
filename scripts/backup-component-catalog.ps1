[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationDirectory,

  [string]$StorageFile,

  [string]$UploadsDirectory,

  [string]$KicadSettingsFile
)

$ErrorActionPreference = "Stop"

$appDirectory = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

if (-not $StorageFile) {
  $StorageFile = if ($env:STORAGE_FILE) {
    $env:STORAGE_FILE
  } else {
    Join-Path $appDirectory "data\storage.json"
  }
}

$storagePath = [System.IO.Path]::GetFullPath($StorageFile)
if (-not (Test-Path -LiteralPath $storagePath -PathType Leaf)) {
  throw "Catalog storage file was not found: $storagePath"
}

$lockPath = "$storagePath.lock"
if (Test-Path -LiteralPath $lockPath) {
  throw "Catalog storage is locked. Close Component Catalog and resolve any stale lock before backing up: $lockPath"
}

if (-not $UploadsDirectory) {
  $UploadsDirectory = if ($env:UPLOADS_DIR) {
    $env:UPLOADS_DIR
  } else {
    Join-Path $appDirectory "uploads"
  }
}

$uploadsPath = [System.IO.Path]::GetFullPath($UploadsDirectory)
if (-not (Test-Path -LiteralPath $uploadsPath -PathType Container)) {
  throw "Managed uploads directory was not found: $uploadsPath"
}

if (-not $KicadSettingsFile) {
  $KicadSettingsFile = if ($env:KICAD_SETTINGS_FILE) {
    $env:KICAD_SETTINGS_FILE
  } else {
    Join-Path (Split-Path -Parent $storagePath) "kicad-settings.json"
  }
}

$settingsPath = [System.IO.Path]::GetFullPath($KicadSettingsFile)
$destinationPath = [System.IO.Path]::GetFullPath($DestinationDirectory)

if (-not (Test-Path -LiteralPath $destinationPath)) {
  New-Item -ItemType Directory -Path $destinationPath | Out-Null
} elseif (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
  throw "Backup destination is not a directory: $destinationPath"
}

$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss'Z'")
$archivePath = Join-Path $destinationPath "component-catalog-backup-$timestamp.zip"
if (Test-Path -LiteralPath $archivePath) {
  throw "Backup archive already exists: $archivePath"
}

$backupItems = @($storagePath, $uploadsPath)
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
  $backupItems += $settingsPath
}

Compress-Archive -LiteralPath $backupItems -DestinationPath $archivePath -CompressionLevel Optimal

$archive = Get-Item -LiteralPath $archivePath
$hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256

Write-Host "Component Catalog backup created:"
Write-Host "  Archive: $($archive.FullName)"
Write-Host "  Size:    $($archive.Length) bytes"
Write-Host "  SHA-256: $($hash.Hash)"
