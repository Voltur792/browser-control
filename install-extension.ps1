param(
    [switch]$Remove,
    [ValidateSet('default', 'yandex', 'chrome', 'edge', 'brave', 'opera', 'vivaldi')]
    [string]$Browser = 'default'
)
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'browser-extension'
$registration = Join-Path $source 'install-native-host.ps1'
$installRoot = Join-Path $env:LOCALAPPDATA 'AstraBrowserControl'
$extensionTarget = Join-Path $installRoot 'browser-extension'

if ($Remove) {
    & $registration -Remove
    Write-Host 'Регистрация локального компонента удалена. Расширение можно удалить на странице расширений браузера.'
    exit 0
}

$hostSource = Join-Path $source 'native-host\portable\BrowserControlNativeHost.exe'
if (-not (Test-Path -LiteralPath $hostSource -PathType Leaf)) {
    throw "В пакете нет автономного Native Messaging Host: $hostSource. Получите полный пакет или запустите browser-extension\build-native-host.ps1."
}
$hostHash = (Get-FileHash -LiteralPath $hostSource -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
$hostTarget = Join-Path (Join-Path $installRoot 'native-host') "BrowserControlNativeHost-$hostHash.exe"

New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $hostTarget) -Force | Out-Null
$extensionFiles = @('manifest.json', 'background.js', 'popup.html', 'popup.css', 'popup.js')
foreach ($name in $extensionFiles) {
    $from = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "В пакете отсутствует файл расширения: $name" }
    Copy-Item -LiteralPath $from -Destination (Join-Path $extensionTarget $name) -Force
}
$sourceIcons = Join-Path $source 'icons'
$targetIcons = Join-Path $extensionTarget 'icons'
New-Item -ItemType Directory -Path $targetIcons -Force | Out-Null
Get-ChildItem -LiteralPath $sourceIcons -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetIcons $_.Name) -Force
}
if (-not (Test-Path -LiteralPath $hostTarget -PathType Leaf)) {
    Copy-Item -LiteralPath $hostSource -Destination $hostTarget
}
& $registration -HostExecutable $hostTarget

$browserCandidates = @(
    @{ Code = 'yandex'; Root = $env:LOCALAPPDATA; Relative = 'Yandex\YandexBrowser\Application\browser.exe'; Url = 'browser://extensions/' },
    @{ Code = 'yandex'; Root = $env:ProgramFiles; Relative = 'Yandex\YandexBrowser\Application\browser.exe'; Url = 'browser://extensions/' },
    @{ Code = 'yandex'; Root = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); Relative = 'Yandex\YandexBrowser\Application\browser.exe'; Url = 'browser://extensions/' },
    @{ Code = 'chrome'; Root = $env:LOCALAPPDATA; Relative = 'Google\Chrome\Application\chrome.exe'; Url = 'chrome://extensions' },
    @{ Code = 'chrome'; Root = $env:ProgramFiles; Relative = 'Google\Chrome\Application\chrome.exe'; Url = 'chrome://extensions' },
    @{ Code = 'chrome'; Root = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); Relative = 'Google\Chrome\Application\chrome.exe'; Url = 'chrome://extensions' },
    @{ Code = 'edge'; Root = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); Relative = 'Microsoft\Edge\Application\msedge.exe'; Url = 'edge://extensions' },
    @{ Code = 'edge'; Root = $env:ProgramFiles; Relative = 'Microsoft\Edge\Application\msedge.exe'; Url = 'edge://extensions' },
    @{ Code = 'brave'; Root = $env:LOCALAPPDATA; Relative = 'BraveSoftware\Brave-Browser\Application\brave.exe'; Url = 'brave://extensions' },
    @{ Code = 'brave'; Root = $env:ProgramFiles; Relative = 'BraveSoftware\Brave-Browser\Application\brave.exe'; Url = 'brave://extensions' },
    @{ Code = 'brave'; Root = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); Relative = 'BraveSoftware\Brave-Browser\Application\brave.exe'; Url = 'brave://extensions' },
    @{ Code = 'opera'; Root = $env:LOCALAPPDATA; Relative = 'Programs\Opera\launcher.exe'; Url = 'opera:extensions' },
    @{ Code = 'opera'; Root = $env:LOCALAPPDATA; Relative = 'Programs\Opera GX\launcher.exe'; Url = 'opera:extensions' },
    @{ Code = 'opera'; Root = $env:ProgramFiles; Relative = 'Opera\launcher.exe'; Url = 'opera:extensions' },
    @{ Code = 'vivaldi'; Root = $env:LOCALAPPDATA; Relative = 'Vivaldi\Application\vivaldi.exe'; Url = 'vivaldi://extensions' },
    @{ Code = 'vivaldi'; Root = $env:ProgramFiles; Relative = 'Vivaldi\Application\vivaldi.exe'; Url = 'vivaldi://extensions' },
    @{ Code = 'vivaldi'; Root = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); Relative = 'Vivaldi\Application\vivaldi.exe'; Url = 'vivaldi://extensions' }
)
$launchTarget = $null
foreach ($candidate in $browserCandidates) {
    if ($Browser -ne 'default' -and $candidate.Code -ne $Browser) { continue }
    if ([string]::IsNullOrWhiteSpace($candidate.Root)) { continue }
    $path = Join-Path -Path $candidate.Root -ChildPath $candidate.Relative
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $launchTarget = @{ Code = $candidate.Code; Path = $path; Url = $candidate.Url }
        break
    }
}
if ($launchTarget) {
    try {
        Start-Process -FilePath $launchTarget.Path -ArgumentList @('--new-tab', $launchTarget.Url)
        Write-Host "Запущен $($launchTarget.Code) с адресом $($launchTarget.Url). Если осталась новая вкладка, вставьте адрес в строку браузера и нажмите Enter."
    }
    catch { Write-Warning "Не удалось открыть страницу расширений: $($_.Exception.Message)" }
} elseif ($Browser -ne 'default') {
    Write-Warning "Выбранный браузер $Browser не найден. Откройте в нём страницу расширений вручную."
}
$folderOpened = $false
try {
    Invoke-Item -LiteralPath $extensionTarget
    $folderOpened = $true
}
catch { Write-Warning "Не удалось открыть папку расширения: $($_.Exception.Message)" }

Write-Host ''
if ($folderOpened) {
    Write-Host 'Локальный компонент установлен. Папка расширения открыта в Проводнике.'
} else {
    Write-Host 'Локальный компонент установлен. Откройте папку расширения вручную.'
}
Write-Host "Папка для «Загрузить распакованное расширение»: $extensionTarget"
Write-Host 'В браузере включите режим разработчика, загрузите указанную папку и нажмите «Проверить подключение».'
