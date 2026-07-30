param(
  [switch]$Lan
)

$ErrorActionPreference = "Stop"

$appDirectory = Split-Path -Parent $PSScriptRoot
$preferredPort = if ($env:PORT) { [int]$env:PORT } else { 5000 }
$phonePort = if ($env:PHONE_ACCESS_PORT) { [int]$env:PHONE_ACCESS_PORT } else { 5002 }
$catalogBindHost = if ($env:HOST) { $env:HOST } else { "127.0.0.1" }
$maxAttempts = 20

. (Join-Path $PSScriptRoot "launch-component-catalog-support.ps1")

function Fail([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
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

function Get-CatalogPorts {
  $ports = [System.Collections.Generic.List[int]]::new()
  for ($port = $preferredPort; $port -le 65535 -and $ports.Count -lt $maxAttempts; $port += 1) {
    if ($port -ne $preferredPort -and $port -eq $phonePort) { continue }
    $ports.Add($port)
  }
  return $ports.ToArray()
}

function Find-ComponentCatalogInstance([string[]]$ProbeHosts) {
  foreach ($probeHost in $ProbeHosts) {
    foreach ($port in Get-CatalogPorts) {
      $baseUrl = Format-HttpBaseUrl $probeHost $port
      try {
        $health = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 1
        if ($health.app -eq "component-catalog" -and $health.status -eq "ok") {
          return [pscustomobject]@{
            Url = $baseUrl
            Health = $health
            ProbeHost = $probeHost
          }
        }
      } catch {
        # This candidate is unused, guarded for another host, or belongs to another app.
      }
    }
  }
  return $null
}

function Open-Catalog([string]$Url) {
  try {
    Start-Process $Url | Out-Null
  } catch {
    Write-Warning "The catalog is running, but Windows could not open the browser automatically. Open $Url manually."
  }
}

function Show-LanAccessSummary([string]$Url, [object]$Target) {
  Write-Host ""
  Write-Host "Phone URL: $Url" -ForegroundColor Yellow
  Write-Host "Network: $($Target.InterfaceAlias) (Windows profile: Private)"
  Write-Host "Connect the phone to the same trusted Wi-Fi/LAN and open that URL."
  Write-Host "If Windows Firewall asks, allow Node.js on Private networks only."
  Write-Host "WARNING: There is no LAN sign-in. A device that can reach this URL can view and change the catalog." -ForegroundColor DarkYellow
}

if ($preferredPort -lt 1 -or $preferredPort -gt 65535) { Fail "PORT must be from 1 to 65535." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js was not found on PATH." }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail "npm was not found on PATH." }
if (-not $Lan -and -not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { Fail "npx was not found on PATH." }

# Keep simultaneous double-clicks (including the older phone/ngrok launcher)
# from both passing the health probe and spawning separate writers.
$launchMutex = Enter-ComponentCatalogLaunchMutex
if (-not $launchMutex) {
  Fail "Another Component Catalog launcher is already starting. Wait for it to finish, then try again."
}

$lanTarget = $null
if ($Lan) {
  try {
    $lanTarget = Get-PrivateLanTarget
  } catch {
    Fail $_.Exception.Message
  }

  if (-not $lanTarget) {
    Fail "No active physical RFC1918 network with a Windows Private profile and default gateway was found. In Windows Settings, mark your trusted home network as Private, reconnect, and try again."
  }

  # Ignore a generic HOST inherited from the shell. LAN mode binds only to the
  # exact address selected from an active physical Private-network adapter.
  $catalogBindHost = [string]$lanTarget.IPAddress

  $catalogInstance = Find-ComponentCatalogInstance -ProbeHosts @($catalogBindHost)
  if ($catalogInstance) {
    if (-not (Test-ProtectedProductionLanInstance $catalogInstance $catalogBindHost)) {
      Fail "A Component Catalog server is already reachable at $($catalogInstance.Url), but it was not started in protected production LAN mode. Close its server window, then run this launcher again."
    }
    Write-Host "Component Catalog is already available on the local network." -ForegroundColor Green
    Show-LanAccessSummary $catalogInstance.Url $lanTarget
    Open-Catalog $catalogInstance.Url
    exit 0
  }

  $localOnlyInstance = Find-ComponentCatalogInstance -ProbeHosts @("127.0.0.1")
  if ($localOnlyInstance) {
    Fail "Component Catalog is already running locally at $($localOnlyInstance.Url). Close its server window, then run the Local Network launcher again so the same data store is not opened by two servers."
  }
} else {
  $catalogProbeHost = ConvertTo-ProbeHost $catalogBindHost
  $catalogInstance = Find-ComponentCatalogInstance -ProbeHosts @($catalogProbeHost)

  # A LAN-mode server deliberately rejects the 127.0.0.1 Host header. If one
  # is already running, find it through the selected Private-network address
  # instead of starting a second process against the same data file.
  if (-not $catalogInstance) {
    try {
      $existingLanTarget = Get-PrivateLanTarget
      if ($existingLanTarget) {
        $catalogInstance = Find-ComponentCatalogInstance -ProbeHosts @([string]$existingLanTarget.IPAddress)
      }
    } catch {
      # Private-network discovery is optional for the normal localhost launch.
    }
  }

  if ($catalogInstance) {
    Write-Host "Component Catalog is already running at $($catalogInstance.Url)." -ForegroundColor Green
    Open-Catalog $catalogInstance.Url
    exit 0
  }
}

$storageLockRecovery = $null
try {
  $storageLockRecovery = Move-StaleComponentCatalogStorageLock $appDirectory
  if ($storageLockRecovery) {
    Write-Host "Recovered a stale storage lock left by stopped process $($storageLockRecovery.OwnerPid)." -ForegroundColor Yellow
  }
} catch {
  Fail $_.Exception.Message
}

if ($Lan) {
  Write-Host "Building the production app for private local-network access..." -ForegroundColor Cyan
  Push-Location $appDirectory
  try {
    & npm.cmd run build
    $buildExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($buildExitCode -ne 0) { Fail "The production build failed." }
} else {
  Write-Host "Starting Component Catalog..." -ForegroundColor Cyan
}

$escapedDirectory = $appDirectory.Replace("'", "''")
$escapedBindHost = $catalogBindHost.Replace("'", "''")
if ($Lan) {
  $windowTitle = "Component Catalog LAN Server"
  $runCommand = "npm.cmd start"
  $accessCommand = "`$env:COMPONENT_CATALOG_LAN_ACCESS='true'"
  $nodeEnvironment = "production"
} else {
  $windowTitle = "Component Catalog Server"
  $runCommand = "npx.cmd tsx watch server/index.ts"
  $accessCommand = "Remove-Item Env:COMPONENT_CATALOG_LAN_ACCESS -ErrorAction SilentlyContinue"
  $nodeEnvironment = "development"
}

$serverCommand = "`$Host.UI.RawUI.WindowTitle='$windowTitle'; Set-Location -LiteralPath '$escapedDirectory'; `$env:NODE_ENV='$nodeEnvironment'; `$env:HOST='$escapedBindHost'; $accessCommand; $runCommand"
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($serverCommand))
Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-NoExit",
  "-EncodedCommand", $encodedCommand
) | Out-Null

Write-Host "Waiting for the server to choose an available port..."
$waitAttempts = if ($Lan) { 60 } else { 30 }
$probeHost = ConvertTo-ProbeHost $catalogBindHost
for ($attempt = 0; $attempt -lt $waitAttempts; $attempt += 1) {
  $catalogInstance = Find-ComponentCatalogInstance -ProbeHosts @($probeHost)
  if ($catalogInstance) {
    if ($Lan -and -not (Test-ProtectedProductionLanInstance $catalogInstance $catalogBindHost)) {
      Fail "A Component Catalog response appeared at $($catalogInstance.Url), but it is not the protected production LAN server. Close that server and the Component Catalog LAN Server window, then try again."
    }
    try {
      Complete-ComponentCatalogStorageLockRecovery $storageLockRecovery
    } catch {
      Write-Warning "The server is ready, but the quarantined stale lock could not be deleted: $($_.Exception.Message)"
    }
    Write-Host "Component Catalog is ready at $($catalogInstance.Url)." -ForegroundColor Green
    if ($Lan) { Show-LanAccessSummary $catalogInstance.Url $lanTarget }
    Open-Catalog $catalogInstance.Url
    exit 0
  }
  Start-Sleep -Seconds 1
}

if ($Lan) {
  Fail "The LAN server did not respond. Check the Component Catalog LAN Server window. If Windows Firewall prompted, allow Node.js on Private networks only, then run this launcher again."
}
Fail "The server did not respond on any fallback port. Check the Component Catalog Server window for the startup error."
