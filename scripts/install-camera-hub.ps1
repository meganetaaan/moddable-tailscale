[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA "StackChanCameraHub"),
    [string]$TaskName = "StackChanCameraHub",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    }
    else {
        Write-Host "Scheduled task '$TaskName' is not installed."
    }
    return
}

$startScript = Join-Path $PSScriptRoot "start-camera-hub.ps1"
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Hub launcher was not found: $startScript"
}

$powerShell = (Get-Process -Id $PID).Path
$quotedScript = '"' + $startScript.Replace('"', '""') + '"'
$quotedState = '"' + $StateDirectory.Replace('"', '""') + '"'
$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File $quotedScript " +
    "-Port $Port -StateDirectory $quotedState"
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser `
    -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description `
    "Starts the private Stack-chan camera hub for this user." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task '$TaskName'."
Write-Host "State is stored in $StateDirectory"
