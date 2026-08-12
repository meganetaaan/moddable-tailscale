[CmdletBinding()]
param(
    [ValidateSet("get", "set", "clear", "restart", "ble", "tailnet-reset")]
    [string]$Command = "get",
    [string]$Port = "COM4",
    [string]$WifiSsid,
    [string]$WifiPassword = "",
    [string]$AuthKey = $env:STACKCHAN_AUTH_KEY,
    [switch]$ClearAuthKey,
    [string]$HubUrl = "ws://stackchan-hub:8080/camera",
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

function New-ProvisionRequest([string]$Name) {
    $requestId = [Guid]::NewGuid().ToString()
    switch ($Name) {
        "get" {
            return @{ type = "provision.get"; requestId = $requestId }
        }
        "set" {
            if ([string]::IsNullOrWhiteSpace($WifiSsid)) {
                throw "-WifiSsid is required for set"
            }
            $config = @{
                wifi = @{ ssid = $WifiSsid; password = $WifiPassword }
                hubURL = $HubUrl
            }
            if ($ClearAuthKey) {
                $config.tailscale = @{ authKey = $null }
            }
            elseif (-not [string]::IsNullOrWhiteSpace($AuthKey)) {
                $config.tailscale = @{ authKey = $AuthKey }
            }
            return @{
                type = "provision.set"
                requestId = $requestId
                config = $config
            }
        }
        "clear" {
            return @{ type = "provision.clear"; requestId = $requestId }
        }
        "restart" {
            return @{ type = "provision.restart"; requestId = $requestId }
        }
        "ble" {
            return @{ type = "provision.ble.start"; requestId = $requestId }
        }
        "tailnet-reset" {
            return @{ type = "provision.tailnet.reset"; requestId = $requestId }
        }
    }
}

function Send-ProvisionRequest(
    [System.IO.Ports.SerialPort]$Serial,
    [hashtable]$Request,
    [int]$TimeoutSeconds = 15
) {
    $json = $Request | ConvertTo-Json -Compress -Depth 8
    $Serial.Write("@stackchan $json`n")
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $line = $Serial.ReadLine()
        }
        catch [System.TimeoutException] {
            continue
        }
        $marker = $line.IndexOf("@stackchan ")
        if ($marker -lt 0) {
            continue
        }
        $payload = $line.Substring($marker + 11).Trim()
        try {
            $response = $payload | ConvertFrom-Json
        }
        catch {
            continue
        }
        if ($response.type -eq "provision.ack" -and $response.requestId -eq $Request.requestId) {
            return $response
        }
    }
    throw "Timed out waiting for provisioning response on $($Serial.PortName)"
}

$serial = [System.IO.Ports.SerialPort]::new($Port, 115200, "None", 8, "One")
$serial.NewLine = "`n"
$serial.ReadTimeout = 500
$serial.WriteTimeout = 2000
$serial.DtrEnable = $false
$serial.RtsEnable = $false

try {
    $serial.Open()
    Start-Sleep -Milliseconds 2500
    $serial.DiscardInBuffer()
    $request = New-ProvisionRequest $Command
    $response = Send-ProvisionRequest $serial $request
    $response | ConvertTo-Json -Depth 8
    if (-not $response.ok) {
        throw "Provisioning failed: $($response.error)"
    }
    if (($Command -eq "set" -or $Command -eq "clear") -and -not $NoRestart) {
        $restart = New-ProvisionRequest "restart"
        [void](Send-ProvisionRequest $serial $restart)
        Write-Host "Device is restarting."
    }
}
finally {
    if ($serial.IsOpen) {
        $serial.Close()
    }
    $serial.Dispose()
}
