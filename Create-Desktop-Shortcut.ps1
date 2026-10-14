<#
  Puts a "Leen Kurdish Studio" shortcut on the Desktop pointing at
  Kurdish-Studio.bat, using the brand mark as its icon.

  Right-click this file and choose "Run with PowerShell", or run:
      powershell -ExecutionPolicy Bypass -File .\Create-Desktop-Shortcut.ps1
#>

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition
$target      = Join-Path $projectRoot "Kurdish-Studio.bat"
$icon        = Join-Path $projectRoot "public\leen.ico"
$desktop     = [Environment]::GetFolderPath("Desktop")
$linkPath    = Join-Path $desktop "Leen Kurdish Studio.lnk"

if (-not (Test-Path $target)) {
    Write-Host "Could not find Kurdish-Studio.bat next to this script. Run it from inside the project folder." -ForegroundColor Red
    exit 1
}

$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($linkPath)
$shortcut.TargetPath       = $target
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description      = "Turn your Kurdish recordings into lesson videos"
if (Test-Path $icon) { $shortcut.IconLocation = $icon }
$shortcut.Save()

Write-Host ""
Write-Host "  Done. 'Leen Kurdish Studio' is on your Desktop." -ForegroundColor Green
Write-Host "  Double-click it any time to start the app." -ForegroundColor Green
Write-Host ""
