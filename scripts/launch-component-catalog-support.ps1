function Test-Rfc1918IPv4Address([string]$Address) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
  if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }

  $bytes = $parsed.GetAddressBytes()
  return $bytes[0] -eq 10 `
    -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) `
    -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Test-IPv4SameSubnet(
  [string]$Address,
  [string]$PeerAddress,
  [int]$PrefixLength
) {
  if ($PrefixLength -lt 0 -or $PrefixLength -gt 32) { return $false }

  $parsedAddress = $null
  $parsedPeer = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) { return $false }
  if (-not [System.Net.IPAddress]::TryParse($PeerAddress, [ref]$parsedPeer)) { return $false }
  if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  if ($parsedPeer.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }

  $left = $parsedAddress.GetAddressBytes()
  $right = $parsedPeer.GetAddressBytes()
  $wholeBytes = [Math]::Floor($PrefixLength / 8)
  for ($index = 0; $index -lt $wholeBytes; $index += 1) {
    if ($left[$index] -ne $right[$index]) { return $false }
  }

  $remainingBits = $PrefixLength % 8
  if ($remainingBits -eq 0) { return $true }
  $mask = (0xFF -shl (8 - $remainingBits)) -band 0xFF
  return ($left[$wholeBytes] -band $mask) -eq ($right[$wholeBytes] -band $mask)
}

function Enter-ComponentCatalogLaunchMutex(
  [string]$Name = "Local\ComponentCatalogLauncherStartup"
) {
  $mutex = [System.Threading.Mutex]::new($false, $Name)
  try {
    $acquired = $mutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }

  if (-not $acquired) {
    $mutex.Dispose()
    return $null
  }
  return $mutex
}

function Test-ComponentCatalogProcessExists([int]$ProcessId) {
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop | Out-Null
    return $true
  } catch {
    if ($_.FullyQualifiedErrorId -like "NoProcessFoundForGivenId*") { return $false }
    throw "Windows could not verify whether process $ProcessId still owns the Component Catalog storage lock: $($_.Exception.Message)"
  }
}

function Get-ComponentCatalogStoragePath([string]$AppDirectory) {
  if ($env:STORAGE_BACKEND -eq "postgres") { return $null }

  $configuredPath = if ($env:STORAGE_FILE) { $env:STORAGE_FILE } else { "data\storage.json" }
  $absolutePath = if ([System.IO.Path]::IsPathRooted($configuredPath)) {
    [System.IO.Path]::GetFullPath($configuredPath)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $AppDirectory $configuredPath))
  }

  $directory = Split-Path -Parent $absolutePath
  $canonicalDirectory = if (Test-Path -LiteralPath $directory -PathType Container) {
    (Resolve-Path -LiteralPath $directory -ErrorAction Stop).Path
  } else {
    [System.IO.Path]::GetFullPath($directory)
  }
  return Join-Path $canonicalDirectory (Split-Path -Leaf $absolutePath)
}

function Read-ComponentCatalogStorageLock([string]$LockPath) {
  $raw = Get-Content -LiteralPath $LockPath -Raw -ErrorAction Stop
  try {
    $owner = $raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The Component Catalog storage lock at $LockPath is malformed. Confirm that no Component Catalog server is running, delete that .lock file, and try again."
  }

  $ownerPid = 0
  if (-not [int]::TryParse([string]$owner.pid, [ref]$ownerPid) -or $ownerPid -le 0) {
    throw "The Component Catalog storage lock at $LockPath has an invalid process ID. Confirm that no Component Catalog server is running, delete that .lock file, and try again."
  }
  $token = [string]$owner.token
  if (-not $token) {
    throw "The Component Catalog storage lock at $LockPath has no owner token. Confirm that no Component Catalog server is running, delete that .lock file, and try again."
  }
  $acquiredAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$owner.acquiredAt, [ref]$acquiredAt)) {
    throw "The Component Catalog storage lock at $LockPath has an invalid timestamp. Confirm that no Component Catalog server is running, delete that .lock file, and try again."
  }

  return [pscustomobject]@{
    Raw = $raw
    Pid = $ownerPid
    Token = $token
    AcquiredAt = $acquiredAt
    StoragePath = [string]$owner.storagePath
  }
}

function Move-StaleComponentCatalogStorageLock(
  [string]$AppDirectory,
  [int]$MinimumAgeSeconds = 30
) {
  $storagePath = Get-ComponentCatalogStoragePath $AppDirectory
  if (-not $storagePath) { return $null }

  $lockPath = "$storagePath.lock"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }

  $owner = Read-ComponentCatalogStorageLock $lockPath
  $ownerStoragePath = try {
    [System.IO.Path]::GetFullPath($owner.StoragePath)
  } catch {
    throw "The Component Catalog storage lock at $lockPath has an invalid storage path. Confirm that no Component Catalog server is running, delete that .lock file, and try again."
  }
  if (-not [string]::Equals($ownerStoragePath, $storagePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Component Catalog storage lock at $lockPath belongs to a different storage path. It was not removed."
  }
  if (Test-ComponentCatalogProcessExists $owner.Pid) {
    throw "Component Catalog storage is still owned by process $($owner.Pid). Close that Component Catalog server and try again."
  }

  $lockInfo = Get-Item -LiteralPath $lockPath -ErrorAction Stop
  $freshestTimestamp = $lockInfo.LastWriteTimeUtc
  if ($owner.AcquiredAt.UtcDateTime -gt $freshestTimestamp) {
    $freshestTimestamp = $owner.AcquiredAt.UtcDateTime
  }
  $ageSeconds = ((Get-Date).ToUniversalTime() - $freshestTimestamp).TotalSeconds
  if ($ageSeconds -lt 0) {
    throw "The Component Catalog storage lock at $lockPath has a future timestamp and was not removed."
  }
  if ($ageSeconds -lt $MinimumAgeSeconds) {
    throw "The Component Catalog storage lock at $lockPath is recent. Wait $MinimumAgeSeconds seconds and run the launcher again."
  }

  # A second read catches watcher restarts or another process changing ownership
  # while the launcher is deciding whether this lock is stale.
  Start-Sleep -Seconds 1
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $null }
  $confirmedOwner = Read-ComponentCatalogStorageLock $lockPath
  if ($confirmedOwner.Raw -ne $owner.Raw -or (Test-ComponentCatalogProcessExists $owner.Pid)) {
    throw "The Component Catalog storage lock changed while it was being checked and was not removed. Wait a few seconds and try again."
  }

  $quarantinePath = "$lockPath.stale.$PID.$([Guid]::NewGuid().ToString('N'))"
  Move-Item -LiteralPath $lockPath -Destination $quarantinePath -ErrorAction Stop
  $quarantinedOwner = Read-ComponentCatalogStorageLock $quarantinePath
  if ($quarantinedOwner.Raw -ne $owner.Raw) {
    if (-not (Test-Path -LiteralPath $lockPath)) {
      Move-Item -LiteralPath $quarantinePath -Destination $lockPath -ErrorAction SilentlyContinue
    }
    throw "The Component Catalog storage lock changed during recovery and was not removed."
  }

  return [pscustomobject]@{
    LockPath = $lockPath
    QuarantinePath = $quarantinePath
    OwnerPid = $owner.Pid
  }
}

function Complete-ComponentCatalogStorageLockRecovery([object]$Recovery) {
  if (-not $Recovery) { return }
  if (Test-Path -LiteralPath $Recovery.QuarantinePath -PathType Leaf) {
    Remove-Item -LiteralPath $Recovery.QuarantinePath -Force -ErrorAction Stop
  }
}

function Select-PrivateLanTarget([object[]]$Candidates) {
  $eligible = @($Candidates | Where-Object {
    $_.NetworkCategory -eq "Private" `
      -and $_.AdapterStatus -eq "Up" `
      -and $_.HardwareInterface -eq $true `
      -and $_.HasDefaultGateway -eq $true `
      -and $_.GatewayOnLink -eq $true `
      -and ($null -eq $_.AddressState -or $_.AddressState -eq "Preferred") `
      -and (Test-Rfc1918IPv4Address ([string]$_.IPAddress))
  } | Sort-Object `
    @{ Expression = { [int]$_.InterfaceMetric } }, `
    @{ Expression = { [int]$_.InterfaceIndex } }, `
    @{ Expression = { [string]$_.InterfaceAlias } }, `
    @{ Expression = { [string]$_.IPAddress } })

  if ($eligible.Count -eq 0) { return $null }
  if ($eligible.Count -gt 1) {
    $descriptions = @($eligible | ForEach-Object { "$($_.InterfaceAlias) ($($_.IPAddress))" })
    throw "Multiple eligible Private-network addresses were found: $($descriptions -join ', '). Disconnect the network that is not shared with the phone, then try again."
  }
  return $eligible[0]
}

function Test-ProtectedProductionLanInstance([object]$Instance, [string]$ExpectedHost) {
  if (-not $Instance -or -not $Instance.Health) { return $false }
  $health = $Instance.Health
  return $null -ne $health.PSObject.Properties["lanAccess"] `
    -and $health.lanAccess -eq $true `
    -and [string]$health.bindHost -eq $ExpectedHost `
    -and $health.productionMode -eq $true
}

function Get-PrivateLanTarget {
  foreach ($command in @("Get-NetConnectionProfile", "Get-NetIPConfiguration")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "$command is unavailable on this version of Windows."
    }
  }

  try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object {
      $_.NetworkCategory -eq "Private"
    })
  } catch {
    throw "Windows would not allow the launcher to inspect network profiles: $($_.Exception.Message)"
  }

  $candidates = [System.Collections.Generic.List[object]]::new()
  foreach ($profile in $profiles) {
    try {
      $configurations = @(Get-NetIPConfiguration -InterfaceIndex $profile.InterfaceIndex -ErrorAction Stop)
    } catch {
      continue
    }

    foreach ($configuration in $configurations) {
      $adapter = $configuration.NetAdapter
      $metric = if ($configuration.NetIPv4Interface) {
        [int]$configuration.NetIPv4Interface.InterfaceMetric
      } else {
        [int]::MaxValue
      }
      $hasDefaultGateway = @($configuration.IPv4DefaultGateway).Count -gt 0
      $defaultGateways = @($configuration.IPv4DefaultGateway | ForEach-Object { [string]$_.NextHop })

      foreach ($address in @($configuration.IPv4Address)) {
        if (-not $address) { continue }
        $prefixLength = if ($address.PSObject.Properties["PrefixLength"]) {
          [int]$address.PrefixLength
        } else {
          -1
        }
        $gatewayOnLink = $false
        foreach ($gateway in $defaultGateways) {
          if (Test-IPv4SameSubnet ([string]$address.IPAddress) $gateway $prefixLength) {
            $gatewayOnLink = $true
            break
          }
        }
        $addressState = if ($address.PSObject.Properties["AddressState"]) {
          [string]$address.AddressState
        } else {
          $null
        }
        $candidates.Add([pscustomobject]@{
          IPAddress = [string]$address.IPAddress
          AddressState = $addressState
          NetworkCategory = [string]$profile.NetworkCategory
          AdapterStatus = [string]$adapter.Status
          HardwareInterface = [bool]$adapter.HardwareInterface
          HasDefaultGateway = $hasDefaultGateway
          GatewayOnLink = $gatewayOnLink
          PrefixLength = $prefixLength
          InterfaceMetric = $metric
          InterfaceIndex = [int]$profile.InterfaceIndex
          InterfaceAlias = [string]$profile.InterfaceAlias
        })
      }
    }
  }

  return Select-PrivateLanTarget $candidates.ToArray()
}
