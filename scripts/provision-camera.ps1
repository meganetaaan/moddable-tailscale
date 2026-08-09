[CmdletBinding()]
param(
    [string]$Port = "COM4",
    [Parameter(Mandatory = $true)]
    [string]$WifiSsid,
    [string]$WifiPassword = "",
    [string]$HubUrl = "ws://stackchan-hub:8080/camera",
    [ValidatePattern('^tag:[a-zA-Z0-9-]+$')]
    [string]$Tag = "tag:stackchan-camera",
    [ValidateRange(300, 86400)]
    [int]$ExpirySeconds = 3600,
    [string]$Tailnet = "-",
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:TS_API_CLIENT_ID) -or
    [string]::IsNullOrWhiteSpace($env:TS_API_CLIENT_SECRET)) {
    throw "Set TS_API_CLIENT_ID and TS_API_CLIENT_SECRET for an OAuth client with auth_keys write access."
}

$oauthPair = "$($env:TS_API_CLIENT_ID):$($env:TS_API_CLIENT_SECRET)"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($oauthPair))
$token = Invoke-RestMethod -Method Post `
    -Uri "https://api.tailscale.com/api/v2/oauth/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "grant_type=client_credentials"
if ([string]::IsNullOrWhiteSpace($token.access_token)) {
    throw "Tailscale OAuth did not return an access token."
}

$request = @{
    capabilities = @{
        devices = @{
            create = @{
                reusable = $false
                ephemeral = $false
                preauthorized = $true
                tags = @($Tag)
            }
        }
    }
    expirySeconds = $ExpirySeconds
    description = "StackCam one-off USB provisioning"
} | ConvertTo-Json -Depth 8

$encodedTailnet = [Uri]::EscapeDataString($Tailnet)
$keyResponse = Invoke-RestMethod -Method Post `
    -Uri "https://api.tailscale.com/api/v2/tailnet/$encodedTailnet/keys" `
    -Headers @{ Authorization = "Bearer $($token.access_token)" } `
    -ContentType "application/json" -Body $request
$authKey = $keyResponse.key
if ([string]::IsNullOrWhiteSpace($authKey)) {
    throw "Tailscale API did not return an auth key."
}

$usbProvisioner = Join-Path $PSScriptRoot "provision-usb.ps1"
try {
    Write-Host "Created a non-reusable $Tag auth key; provisioning $Port."
    & $usbProvisioner set -Port $Port -WifiSsid $WifiSsid `
        -WifiPassword $WifiPassword -AuthKey $authKey -HubUrl $HubUrl `
        -NoRestart:$NoRestart
    Write-Host "Provisioning completed. The auth key was not written to disk."
}
finally {
    $authKey = $null
    $keyResponse = $null
    $token = $null
}
