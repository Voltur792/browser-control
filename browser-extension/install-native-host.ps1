param([switch]$Remove, [string]$HostExecutable = '')
$ErrorActionPreference = 'Stop'
$hostName = 'com.voltur.browser_control'
$extensionId = 'gfnmcopdoaehakblkhonjloehlhfjgod'
$root = $PSScriptRoot
$portableExe = Join-Path $root 'native-host\portable\BrowserControlNativeHost.exe'
$exePath = if ($HostExecutable) { $HostExecutable } else { $portableExe }
$manifestPath = Join-Path $env:LOCALAPPDATA 'BrowserControl\com.voltur.browser_control.json'
$keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Yandex\YandexBrowser\NativeMessagingHosts\$hostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

if ($Remove) {
    foreach ($key in $keys) {
        if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Force }
    }
    if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force }
    Write-Host 'Native Messaging Host удалён из профиля текущего пользователя.'
    exit 0
}

if (-not (Test-Path -LiteralPath $exePath)) {
    throw "Не найден $exePath. Получите полный пакет плагина или запустите build-native-host.ps1."
}
$exePath = (Resolve-Path -LiteralPath $exePath).Path

$manifest = @{
    name = $hostName
    description = 'Локальный мост Astra Browser Control'
    path = $exePath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
} | ConvertTo-Json -Depth 4
$manifestDirectory = Split-Path -Parent $manifestPath
New-Item -ItemType Directory -Path $manifestDirectory -Force | Out-Null
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
foreach ($key in $keys) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -LiteralPath $key -Value $manifestPath
}
Write-Host 'Native Messaging Host зарегистрирован для текущего пользователя.'
Write-Host "Манифест: $manifestPath"
Write-Host 'Перезапустите браузер, затем нажмите «Проверить соединение» в Astra.'
