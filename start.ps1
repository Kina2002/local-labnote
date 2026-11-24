$ErrorActionPreference = 'Stop'
$labnoteExe = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Labnote*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($labnoteExe) {
    Start-Process -FilePath $labnoteExe.FullName -WorkingDirectory $PSScriptRoot
    return
}
$labnotePython = (Get-Command python -ErrorAction Stop).Source
$labnotePythonw = Join-Path (Split-Path $labnotePython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $labnotePythonw)) {
    throw 'pythonw.exe is required.'
}
Start-Process -FilePath $labnotePythonw -ArgumentList ('"' + (Join-Path $PSScriptRoot 'app.py') + '"') -WorkingDirectory $PSScriptRoot
