# 构建 DSH 备份助手：单文件、自包含的 WinForms EXE。
# 用法：powershell -ExecutionPolicy Bypass -File tool\build.ps1 [输出目录]
# 缺省输出到 tool\bin。
$ErrorActionPreference = "Stop"
$tool = $PSScriptRoot
$repo = Split-Path $tool -Parent
$stage = Join-Path $tool "payload\stage"
$zip = Join-Path $tool "payload\plugin.zip"
$out = if ($args.Count -gt 0) { $args[0] } else { Join-Path $tool "bin" }
$exe = Join-Path $out "DSH备份助手.exe"

Write-Host "1/4 组装插件包 ..."
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null
# 与 PluginInstaller.PluginFiles、插件 package.json 的 files 字段同源：三处必须一致。
foreach ($rel in @("package.json", "cordis.patch.yml", "README.md", "lib\index.js", "lib\backup.js", "lib\client.js")) {
  $src = Join-Path $repo $rel
  if (-not (Test-Path $src)) { throw "缺少 $rel" }
  $dst = Join-Path $stage $rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
  Copy-Item $src $dst -Force
}
Remove-Item $zip -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Split-Path $zip -Parent) | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host ("     plugin.zip = {0} 字节" -f (Get-Item $zip).Length)

Write-Host "2/4 还原依赖 ..."
Push-Location $tool
& dotnet restore | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "dotnet restore 失败" }
Pop-Location

Write-Host "3/4 发布单文件 ..."
Push-Location $tool
& dotnet publish -c Release -r win-x64 --self-contained true -o $out -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=none -p:PublishReadyToRun=false --nologo -v quiet
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "dotnet publish 失败，退出码 $LASTEXITCODE" }
Pop-Location

Write-Host "4/4 收尾 ..."
Get-ChildItem $out -File | Where-Object { $_.Name -ne "DSH备份助手.exe" } | Remove-Item -Force
$info = Get-Item $exe
Write-Host "EXE: $exe"
Write-Host ("大小: {0} 字节" -f $info.Length)
Write-Host ("版本: {0}" -f $info.VersionInfo.ProductVersion)
