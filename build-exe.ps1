$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $webData = (Join-Path $PSScriptRoot 'web') + ':web'
    python -m PyInstaller --onefile --windowed --noconfirm --clean --noupx --name Labnote --add-data $webData --collect-all webview --hidden-import pymupdf --distpath . --workpath build\pyinstaller --specpath build app.py
    if ($LASTEXITCODE -ne 0) { throw 'EXE build failed.' }
    Write-Output (Join-Path $PSScriptRoot 'Labnote.exe')
} finally {
    Pop-Location
}
