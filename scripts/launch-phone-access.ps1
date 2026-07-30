$ErrorActionPreference = "Stop"

$appDirectory = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $appDirectory ".env.phone.local"

. (Join-Path $PSScriptRoot "launch-component-catalog-support.ps1")

function Fail([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Read-PhoneSettings([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Fail "Missing .env.phone.local. Copy .env.phone.example, fill in the ngrok and Auth0 values, and try again."
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $separator = $trimmed.IndexOf("=")
    if ($separator -lt 1) { continue }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Test-PhoneAccessService([string]$Url) {
  try {
    $health = Invoke-RestMethod -Uri $Url -TimeoutSec 2
    return $health.status -eq "ok" `
      -and $health.service -eq "component-catalog-phone-access" `
      -and $health.oauth -eq "required"
  } catch {
    return $false
  }
}

function ConvertTo-ProbeHost([string]$HostName) {
  if ($HostName -eq "0.0.0.0") { return "127.0.0.1" }
  if ($HostName -eq "::") { return "::1" }
  return $HostName
}

function Format-HttpBaseUrl([string]$HostName, [int]$Port) {
  $urlHost = if ($HostName.Contains(":") -and -not $HostName.StartsWith("[")) {
    "[$HostName]"
  } else {
    $HostName
  }
  return "http://${urlHost}:$Port"
}

function Find-ComponentCatalogUrl(
  [int]$PreferredPort,
  [int]$ReservedPhonePort,
  [string]$ProbeHost
) {
  $checked = 0
  for ($port = $PreferredPort; $port -le 65535 -and $checked -lt 20; $port += 1) {
    if ($port -ne $PreferredPort -and $port -eq $ReservedPhonePort) { continue }
    $checked += 1
    $baseUrl = Format-HttpBaseUrl $ProbeHost $port
    try {
      $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1
      if ($health.app -eq "component-catalog" -and $health.status -eq "ok") {
        return $baseUrl
      }
    } catch {
      # This candidate is unused or belongs to another local application.
    }
  }
  return $null
}

function Get-NgrokPublicUrls {
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
    return @($status.tunnels | ForEach-Object { $_.public_url.TrimEnd('/') })
  } catch {
    return @()
  }
}

Read-PhoneSettings $settingsPath

if ($env:PHONE_ACCESS_ENABLED -ne "true") { Fail "PHONE_ACCESS_ENABLED must be true." }
if (-not $env:MCP_PUBLIC_URL) { Fail "MCP_PUBLIC_URL is missing from .env.phone.local." }
if (-not $env:AUTH0_ISSUER) { Fail "AUTH0_ISSUER is missing from .env.phone.local." }
if (-not $env:AUTH0_AUDIENCE) { Fail "AUTH0_AUDIENCE is missing from .env.phone.local." }
if ($env:MCP_PUBLIC_URL -notmatch '^https://') { Fail "MCP_PUBLIC_URL must begin with https://." }

$phonePort = if ($env:PHONE_ACCESS_PORT) { [int]$env:PHONE_ACCESS_PORT } else { 5002 }
$phoneBindHost = if ($env:PHONE_ACCESS_HOST) { $env:PHONE_ACCESS_HOST } else { "127.0.0.1" }
$phoneProbeHost = ConvertTo-ProbeHost $phoneBindHost
$phoneHealthUrl = "$(Format-HttpBaseUrl $phoneProbeHost $phonePort)/health"
$preferredCatalogPort = if ($env:PORT) { [int]$env:PORT } else { 5000 }
$catalogBindHost = "127.0.0.1"
$catalogProbeHost = ConvertTo-ProbeHost $catalogBindHost
$catalogUrl = Find-ComponentCatalogUrl $preferredCatalogPort $phonePort $catalogProbeHost
$expectedPublicUrl = $env:MCP_PUBLIC_URL.TrimEnd('/')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on PATH." }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Fail "npx was not found on PATH." }
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
  Fail "ngrok was not found on PATH. Install it, run 'ngrok config add-authtoken YOUR_TOKEN', and try again."
}

$launchMutex = Enter-ComponentCatalogLaunchMutex
if (-not $launchMutex) {
  Fail "Another Component Catalog launcher is already starting. Wait for it to finish, then try again."
}

$lanCatalogUrl = $null
if (-not $catalogUrl) {
  try {
    $existingLanTarget = Get-PrivateLanTarget
    if ($existingLanTarget) {
      $lanCatalogUrl = Find-ComponentCatalogUrl $preferredCatalogPort $phonePort ([string]$existingLanTarget.IPAddress)
    }
  } catch {
    # LAN discovery is best-effort for the legacy ngrok launcher.
  }
}

$phoneRunning = Test-PhoneAccessService $phoneHealthUrl
if (-not $phoneRunning -and ($catalogUrl -or $lanCatalogUrl)) {
  $runningUrl = if ($catalogUrl) { $catalogUrl } else { $lanCatalogUrl }
  Fail "Component Catalog is already running without phone access at $runningUrl. Close its server window, then run this launcher again."
}
if ($phoneRunning -and -not $catalogUrl -and $lanCatalogUrl) {
  $catalogUrl = $lanCatalogUrl
}

$storageLockRecovery = $null
if (-not $phoneRunning -and -not $catalogUrl -and -not $lanCatalogUrl) {
  try {
    $storageLockRecovery = Move-StaleComponentCatalogStorageLock $appDirectory
    if ($storageLockRecovery) {
      Write-Host "Recovered a stale storage lock left by stopped process $($storageLockRecovery.OwnerPid)." -ForegroundColor Yellow
    }
  } catch {
    Fail $_.Exception.Message
  }
}

if (-not $phoneRunning) {
  Write-Host "Starting Component Catalog with the loopback-only phone service..." -ForegroundColor Cyan
  $escapedDirectory = $appDirectory.Replace("'", "''")
  $serverCommand = "Set-Location -LiteralPath '$escapedDirectory'; `$env:NODE_ENV='development'; `$env:HOST='127.0.0.1'; Remove-Item Env:COMPONENT_CATALOG_LAN_ACCESS -ErrorAction SilentlyContinue; npx.cmd tsx watch server/index.ts"
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($serverCommand))
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-NoExit",
    "-EncodedCommand", $encodedCommand
  ) | Out-Null

  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    if (Test-PhoneAccessService $phoneHealthUrl) { $phoneRunning = $true }
    $catalogUrl = Find-ComponentCatalogUrl $preferredCatalogPort $phonePort $catalogProbeHost
    if ($phoneRunning -and $catalogUrl) {
      try {
        Complete-ComponentCatalogStorageLockRecovery $storageLockRecovery
      } catch {
        Write-Warning "The server is ready, but the quarantined stale lock could not be deleted: $($_.Exception.Message)"
      }
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $phoneRunning) {
    Fail "The phone service did not respond on port $phonePort. Check the Component Catalog server window for the configuration error."
  }
  if (-not $catalogUrl) {
    Fail "The catalog UI did not respond on any fallback port. Check the Component Catalog server window for the startup error."
  }
}

if (-not $catalogUrl) {
  $catalogUrl = Find-ComponentCatalogUrl $preferredCatalogPort $phonePort $catalogProbeHost
}
if (-not $catalogUrl) { Fail "The phone service is running, but the catalog UI could not be located." }

$publicUrls = Get-NgrokPublicUrls
if ($publicUrls -notcontains $expectedPublicUrl) {
  if ($publicUrls.Count -gt 0) {
    Fail "ngrok is already forwarding a different URL: $($publicUrls -join ', '). Stop that ngrok process and retry."
  }

  Write-Host "Starting ngrok for the private MCP port..." -ForegroundColor Cyan
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile",
    "-NoExit",
    "-Command", "ngrok http $phonePort"
  ) | Out-Null

  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Seconds 1
    $publicUrls = Get-NgrokPublicUrls
    if ($publicUrls.Count -gt 0) { break }
  }
}

if ($publicUrls -notcontains $expectedPublicUrl) {
  $actual = if ($publicUrls.Count -gt 0) { $publicUrls -join ", " } else { "no public URL reported" }
  Fail "ngrok reported '$actual', but MCP_PUBLIC_URL is '$expectedPublicUrl'. Update .env.phone.local to the assigned ngrok URL and restart both windows."
}

$publicHealth = "$expectedPublicUrl/health"
for ($attempt = 0; $attempt -lt 15; $attempt += 1) {
  if (Test-PhoneAccessService $publicHealth) {
    Write-Host "Phone access is online." -ForegroundColor Green
    Write-Host "MCP endpoint: $expectedPublicUrl/mcp"
    Write-Host "Keep the Component Catalog and ngrok windows open while using ChatGPT on your phone."
    Start-Process $catalogUrl | Out-Null
    exit 0
  }
  Start-Sleep -Seconds 1
}

Fail "ngrok is running, but the public health check failed at $publicHealth. Check the ngrok window for connection errors."
