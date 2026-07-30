$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "launch-component-catalog-support.ps1")

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$testMutex = Enter-ComponentCatalogLaunchMutex "Local\ComponentCatalogLauncherTest-$PID"
Assert-True ($null -ne $testMutex) "The launcher should be able to acquire its startup mutex."
$testMutex.ReleaseMutex()
$testMutex.Dispose()

foreach ($address in @("10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254")) {
  Assert-True (Test-Rfc1918IPv4Address $address) "Expected $address to be accepted as RFC1918."
}
foreach ($address in @("9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.1.1", "127.0.0.1", "169.254.1.1", "::1", "not-an-ip")) {
  Assert-True (-not (Test-Rfc1918IPv4Address $address)) "Expected $address to be rejected."
}
Assert-True (Test-IPv4SameSubnet "192.168.50.48" "192.168.50.1" 24) "Addresses in the same /24 should match."
Assert-True (-not (Test-IPv4SameSubnet "192.168.50.48" "192.168.51.1" 24)) "Addresses in different /24 networks should not match."
Assert-True (Test-IPv4SameSubnet "172.31.15.2" "172.31.0.1" 16) "Addresses in the same /16 should match."
Assert-True (-not (Test-IPv4SameSubnet "10.0.0.1" "10.0.0.2" 33)) "Invalid prefixes should be rejected."

$base = @{
  AddressState = "Preferred"
  NetworkCategory = "Private"
  AdapterStatus = "Up"
  HardwareInterface = $true
  HasDefaultGateway = $true
  GatewayOnLink = $true
  PrefixLength = 24
  InterfaceMetric = 25
  InterfaceIndex = 10
  InterfaceAlias = "Ethernet"
}
function Candidate([string]$Address, [hashtable]$Overrides = @{}) {
  $values = @{} + $base
  foreach ($entry in $Overrides.GetEnumerator()) { $values[$entry.Key] = $entry.Value }
  return [pscustomobject](@{ IPAddress = $Address } + $values)
}

$target = Select-PrivateLanTarget @(
  (Candidate "10.5.0.2" @{ HardwareInterface = $false; InterfaceMetric = 1; InterfaceAlias = "VPN" }),
  (Candidate "172.18.32.1" @{ HasDefaultGateway = $false; InterfaceMetric = 5; InterfaceAlias = "Hyper-V" }),
  (Candidate "192.168.50.49" @{ InterfaceMetric = 10; InterfaceIndex = 4; InterfaceAlias = "Ethernet" }),
  (Candidate "192.168.50.50" @{ NetworkCategory = "Public"; InterfaceMetric = 1 }),
  (Candidate "192.168.50.51" @{ AddressState = "Tentative"; InterfaceMetric = 1 }),
  (Candidate "192.168.50.52" @{ AdapterStatus = "Down"; InterfaceMetric = 1 }),
  (Candidate "192.168.51.52" @{ GatewayOnLink = $false; InterfaceMetric = 1 })
)

Assert-True ($null -ne $target) "Expected one eligible private LAN target."
Assert-True ($target.IPAddress -eq "192.168.50.49") "The sole eligible physical adapter should win."
Assert-True ($null -eq (Select-PrivateLanTarget @(
  (Candidate "192.168.50.60" @{ NetworkCategory = "Public" }),
  (Candidate "169.254.10.20")
))) "An ineligible candidate set should return no target."

$ambiguousSelectionRejected = $false
try {
  Select-PrivateLanTarget @(
    (Candidate "192.168.50.48" @{ InterfaceIndex = 12; InterfaceAlias = "Wi-Fi" }),
    (Candidate "10.0.0.48" @{ InterfaceIndex = 4; InterfaceAlias = "Ethernet" })
  ) | Out-Null
} catch {
  $ambiguousSelectionRejected = $_.Exception.Message -match "Multiple eligible Private-network addresses"
}
Assert-True $ambiguousSelectionRejected "Ambiguous physical Private networks should require the user to disconnect one."

$protectedInstance = [pscustomobject]@{
  Health = [pscustomobject]@{
    lanAccess = $true
    bindHost = "192.168.50.48"
    productionMode = $true
  }
}
Assert-True (Test-ProtectedProductionLanInstance $protectedInstance "192.168.50.48") "A protected production LAN instance should be reusable."
Assert-True (-not (Test-ProtectedProductionLanInstance $protectedInstance "192.168.50.49")) "A server bound to another address should not be reused."
Assert-True (-not (Test-ProtectedProductionLanInstance ([pscustomobject]@{
  Health = [pscustomobject]@{ lanAccess = $true; bindHost = "192.168.50.48"; productionMode = $false }
}) "192.168.50.48")) "A development server should not be reused in LAN mode."
Assert-True (-not (Test-ProtectedProductionLanInstance ([pscustomobject]@{
  Health = [pscustomobject]@{ bindHost = "192.168.50.48"; productionMode = $true }
}) "192.168.50.48")) "A legacy or unguarded server should not be reused in LAN mode."

$lockTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) "component-catalog-launch-lock-$PID-$([Guid]::NewGuid().ToString('N'))"
$lockTestStorage = Join-Path $lockTestRoot "storage.json"
$lockTestPath = "$lockTestStorage.lock"
$previousStorageBackend = $env:STORAGE_BACKEND
$previousStorageFile = $env:STORAGE_FILE

function Write-LockFixture([int]$OwnerPid, [string]$StoragePath, [DateTimeOffset]$AcquiredAt) {
  @{
    pid = $OwnerPid
    token = [Guid]::NewGuid().ToString()
    acquiredAt = $AcquiredAt.ToUniversalTime().ToString("o")
    storagePath = $StoragePath
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $lockTestPath -Encoding UTF8
  (Get-Item -LiteralPath $lockTestPath).LastWriteTimeUtc = $AcquiredAt.UtcDateTime
}

try {
  New-Item -ItemType Directory -Path $lockTestRoot -Force | Out-Null
  Remove-Item Env:STORAGE_BACKEND -ErrorAction SilentlyContinue
  $env:STORAGE_FILE = $lockTestStorage

  Assert-True ($null -eq (Move-StaleComponentCatalogStorageLock $lockTestRoot)) "No lock should require no recovery."

  Write-LockFixture $PID $lockTestStorage ([DateTimeOffset]::UtcNow.AddMinutes(-5))
  $activeLockRejected = $false
  try { Move-StaleComponentCatalogStorageLock $lockTestRoot | Out-Null } catch {
    $activeLockRejected = $_.Exception.Message -match "still owned by process"
  }
  Assert-True $activeLockRejected "A lock owned by a live process must never be recovered."
  Assert-True (Test-Path -LiteralPath $lockTestPath) "The live owner's lock must remain in place."
  Remove-Item -LiteralPath $lockTestPath -Force

  Write-LockFixture 2147483647 $lockTestStorage ([DateTimeOffset]::UtcNow)
  $recentLockRejected = $false
  try { Move-StaleComponentCatalogStorageLock $lockTestRoot | Out-Null } catch {
    $recentLockRejected = $_.Exception.Message -match "is recent"
  }
  Assert-True $recentLockRejected "A recent dead-owner lock should be left alone during startup races."
  Remove-Item -LiteralPath $lockTestPath -Force

  Write-LockFixture 2147483647 $lockTestStorage ([DateTimeOffset]::UtcNow.AddMinutes(-5))
  $recovery = Move-StaleComponentCatalogStorageLock $lockTestRoot
  Assert-True ($null -ne $recovery) "An old unchanged lock from a dead process should be quarantined."
  Assert-True (-not (Test-Path -LiteralPath $lockTestPath)) "The stale lock should leave the active lock path."
  Assert-True (Test-Path -LiteralPath $recovery.QuarantinePath) "The stale lock should remain quarantined until startup succeeds."
  Complete-ComponentCatalogStorageLockRecovery $recovery
  Assert-True (-not (Test-Path -LiteralPath $recovery.QuarantinePath)) "Successful startup should delete the quarantined stale lock."

  Write-LockFixture 2147483647 (Join-Path $lockTestRoot "other.json") ([DateTimeOffset]::UtcNow.AddMinutes(-5))
  $mismatchedLockRejected = $false
  try { Move-StaleComponentCatalogStorageLock $lockTestRoot | Out-Null } catch {
    $mismatchedLockRejected = $_.Exception.Message -match "different storage path"
  }
  Assert-True $mismatchedLockRejected "A lock for another storage path must not be recovered."
} finally {
  if ($null -eq $previousStorageBackend) { Remove-Item Env:STORAGE_BACKEND -ErrorAction SilentlyContinue } else { $env:STORAGE_BACKEND = $previousStorageBackend }
  if ($null -eq $previousStorageFile) { Remove-Item Env:STORAGE_FILE -ErrorAction SilentlyContinue } else { $env:STORAGE_FILE = $previousStorageFile }
  Remove-Item -LiteralPath $lockTestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "LAN launcher verification passed."
