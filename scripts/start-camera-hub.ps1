[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "StackChanCameraHub"),
    [string]$BindAddress
)

$ErrorActionPreference = "Stop"

function Resolve-Program([string]$Name, [string[]]$FallbackPaths) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    foreach ($candidate in $FallbackPaths) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    throw "$Name was not found. Install it or add it to PATH."
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $repositoryRoot "tools\camera-server.ts"
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
    throw "Camera server was not found: $serverPath"
}

$deno = Resolve-Program "deno.exe" @(
    (Join-Path $env:USERPROFILE "scoop\shims\deno.exe")
)
$tailscale = Resolve-Program "tailscale.exe" @(
    (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe")
)

if ([string]::IsNullOrWhiteSpace($BindAddress)) {
    $tailnetAddresses = @(& $tailscale ip -4)
    if ($LASTEXITCODE -ne 0 -or $tailnetAddresses.Count -eq 0) {
        throw "Could not resolve this PC's Tailscale IPv4 address."
    }
    $BindAddress = $tailnetAddresses[0].Trim()
}

[void](New-Item -ItemType Directory -Path $StateDirectory -Force)
$mutex = [Threading.Mutex]::new($false, "Local\StackChanCameraHub-$Port")
$ownsMutex = $false
try {
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) {
        Write-Host "Stack-chan camera hub is already running on port $Port."
        return
    }

    Write-Host "Starting Stack-chan camera hub on $BindAddress`:$Port"
    Write-Host "Persistent state: $StateDirectory"
    & $deno run --allow-net "--allow-read=$StateDirectory" `
        "--allow-write=$StateDirectory" $serverPath $Port $BindAddress `
        "--state-dir=$StateDirectory"
    if ($LASTEXITCODE -ne 0) {
        throw "Camera hub exited with code $LASTEXITCODE."
    }
}
finally {
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
