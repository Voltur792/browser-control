$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'native-host\BrowserControlNativeHost.csproj'
$project = Join-Path $PSScriptRoot 'native-host'
$config = Join-Path $project 'NuGet.Config'
$output = Join-Path $PSScriptRoot 'native-host\portable'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'Для сборки Native Messaging Host установите .NET SDK 9 или новее.'
}
Push-Location $project
try {
    dotnet restore $source --configfile $config -r win-x64 --source 'https://api.nuget.org/v3/index.json'
    if ($LASTEXITCODE -ne 0) { throw "Восстановление .NET-проекта завершилось с кодом $LASTEXITCODE" }
    dotnet publish $source --no-restore -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false -p:UseAppHost=true -o $output
    if ($LASTEXITCODE -ne 0) { throw "Сборка Native Messaging Host завершилась с кодом $LASTEXITCODE" }
}
finally { Pop-Location }
Write-Host "Готово: $output"
