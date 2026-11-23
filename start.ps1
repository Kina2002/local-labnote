$ErrorActionPreference = 'Stop'
$labnoteExe = Join-Path $PSScriptRoot 'Labnote.exe'
if (Test-Path -LiteralPath $labnoteExe) {
    Start-Process -FilePath $labnoteExe -WorkingDirectory $PSScriptRoot
    return
}
$labnotePython = (Get-Command python -ErrorAction Stop).Source
$labnotePythonw = Join-Path (Split-Path $labnotePython) 'pythonw.exe'
if (-not (Test-Path -LiteralPath $labnotePythonw)) {
    throw 'pythonw.exe is required.'
}
Start-Process -FilePath $labnotePythonw -ArgumentList ('"' + (Join-Path $PSScriptRoot 'app.py') + '"') -WorkingDirectory $PSScriptRoot
