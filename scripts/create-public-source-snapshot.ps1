[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Destination
)

$ErrorActionPreference = "Stop"

$sourceRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$destinationPath = [System.IO.Path]::GetFullPath($Destination)

if ($destinationPath -eq $sourceRoot) {
  throw "Destination must not be the source repository."
}

$sourcePrefix = $sourceRoot.TrimEnd('\') + '\'
if ($destinationPath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must be outside the private source repository."
}

if (Test-Path -LiteralPath $destinationPath) {
  $existingItems = @(Get-ChildItem -LiteralPath $destinationPath -Force)
  if ($existingItems.Count -gt 0) {
    throw "Destination already exists and is not empty: $destinationPath"
  }
} else {
  New-Item -ItemType Directory -Path $destinationPath | Out-Null
}

$rootFiles = @(
  ".env.phone.example",
  ".gitignore",
  "ASSET_PROVENANCE.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "components.json",
  "drizzle.config.ts",
  "example-import.json",
  "Launch Component Catalog.cmd",
  "Launch Component Catalog on Local Network.cmd",
  "Launch Component Catalog Phone Access.cmd",
  "package-lock.json",
  "package.json",
  "postcss.config.js",
  "tailwind.config.ts",
  "tsconfig.json",
  "tsconfig.verify.json",
  "vite.config.ts"
)

$allowedTrackedPrefixes = @(
  "client/",
  "default-cases/",
  "migrations/",
  "server/",
  "shared/",
  "skills/"
)

$scriptFiles = @(
  "scripts/backup-component-catalog.ps1",
  "scripts/create-public-source-snapshot.ps1",
  "scripts/launch-component-catalog.ps1",
  "scripts/launch-component-catalog-support.ps1",
  "scripts/launch-phone-access.ps1",
  "scripts/start-production.mjs",
  "scripts/verify-app.ts",
  "scripts/verify-case-3d-geometry.ts",
  "scripts/verify-lan-access.ts",
  "scripts/verify-lan-launch.ps1",
  "scripts/verify-model-viewer-wrapper.ts",
  "scripts/verify-persistence-worker.ts",
  "scripts/verify-phone-component-finder.ts",
  "scripts/verify-port-fallback.ts",
  "scripts/verify-storage-process-lock.ts",
  "scripts/verify-storage-process-lock-worker.ts"
)

$githubFiles = @(
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/pull_request_template.md",
  ".github/workflows/ci.yml"
)

$documentationFiles = @(
  "docs/images/01-case-library.png",
  "docs/images/02-case-inventory-grid.png",
  "docs/images/03-3d-case-locator.png",
  "docs/images/05-component-search.png",
  "docs/images/09-case-creator.png",
  "docs/images/10-custom-case-layout.png"
)

$safeDirectory = $sourceRoot.Replace('\', '/')
$trackedFiles = @(& git -c "safe.directory=$safeDirectory" -C $sourceRoot ls-files)
if ($LASTEXITCODE -ne 0) {
  throw "Could not read the private repository's tracked-file list."
}

$selectedFiles = [System.Collections.Generic.HashSet[string]]::new(
  [System.StringComparer]::OrdinalIgnoreCase
)

foreach ($relativePath in $rootFiles + $scriptFiles + $githubFiles + $documentationFiles) {
  [void]$selectedFiles.Add($relativePath.Replace('\', '/'))
}

foreach ($relativePath in $trackedFiles) {
  $normalizedPath = $relativePath.Replace('\', '/')
  foreach ($prefix in $allowedTrackedPrefixes) {
    if ($normalizedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      [void]$selectedFiles.Add($normalizedPath)
      break
    }
  }
}

foreach ($relativePath in @($selectedFiles) | Sort-Object) {
  $platformRelativePath = $relativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $sourcePath = Join-Path $sourceRoot $platformRelativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Required public source file is missing: $relativePath"
  }

  $targetPath = Join-Path $destinationPath $platformRelativePath
  $targetDirectory = Split-Path -Parent $targetPath
  if (-not (Test-Path -LiteralPath $targetDirectory)) {
    New-Item -ItemType Directory -Path $targetDirectory | Out-Null
  }

  Copy-Item -LiteralPath $sourcePath -Destination $targetPath
}

$publicReadmePath = Join-Path $destinationPath "README.md"
$publicReadme = [System.IO.File]::ReadAllText($publicReadmePath)
$privateBlocks = @(
  "(?ms)^<!-- PRIVATE_RELEASE_NOTICE_START -->\r?\n.*?^<!-- PRIVATE_RELEASE_NOTICE_END -->\r?\n?",
  "(?ms)^<!-- PRIVATE_RELEASE_GUIDE_START -->\r?\n.*?^<!-- PRIVATE_RELEASE_GUIDE_END -->\r?\n?"
)

foreach ($pattern in $privateBlocks) {
  $publicReadme = [System.Text.RegularExpressions.Regex]::Replace($publicReadme, $pattern, "")
}

[System.IO.File]::WriteAllText(
  $publicReadmePath,
  $publicReadme.TrimEnd() + [Environment]::NewLine,
  [System.Text.UTF8Encoding]::new($false)
)

$forbiddenRelativePaths = @(
  ".git",
  ".replit",
  "attached_assets",
  "data",
  "generated-icon.png",
  "migrate-data.js",
  "migrate-data.ts",
  "migrate.js",
  "opacity",
  "output",
  "scripts\auto-assign-component-models.ts",
  "screenshots",
  "tmp",
  "uploads"
)

foreach ($relativePath in $forbiddenRelativePaths) {
  if (Test-Path -LiteralPath (Join-Path $destinationPath $relativePath)) {
    throw "Forbidden private or legacy path entered the public snapshot: $relativePath"
  }
}

$requiredCaseModels = @(
  "default-cases\all-small.glb",
  "default-cases\mixed.glb",
  "default-cases\variant.glb"
)

foreach ($relativePath in $requiredCaseModels) {
  if (-not (Test-Path -LiteralPath (Join-Path $destinationPath $relativePath) -PathType Leaf)) {
    throw "Original bundled case model is missing: $relativePath"
  }
}

$privateMarkers = Select-String -LiteralPath $publicReadmePath -Pattern "PRIVATE_RELEASE_" -SimpleMatch
if ($privateMarkers) {
  throw "Private-release-only README markers remain in the public snapshot."
}

Write-Host "Created sanitized public source snapshot:"
Write-Host "  $destinationPath"
