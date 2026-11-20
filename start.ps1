param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$labnoteAddress = 'http://127.0.0.1:8765'
$labnoteListener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if (-not $labnoteListener) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
    $labnotePython = (Get-Command python -ErrorAction Stop).Source
    $labnoteArgs = @('-u', ('"' + (Join-Path $PSScriptRoot 'server.py') + '"'), '--no-browser')
    $labnoteProcess = Start-Process -FilePath $labnotePython -ArgumentList $labnoteArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'data/server-output.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data/server-error.log')
    $labnoteReady = $false
    for ($labnoteAttempt = 0; $labnoteAttempt -lt 30; $labnoteAttempt++) {
        if ($labnoteProcess.HasExited) { throw 'Labnote server exited. Check data/server-error.log.' }
        try {
            $labnoteResponse = Invoke-WebRequest -Uri $labnoteAddress -UseBasicParsing -TimeoutSec 1
            if ($labnoteResponse.StatusCode -eq 200) { $labnoteReady = $true; break }
        } catch { Start-Sleep -Milliseconds 300 }
    }
    if (-not $labnoteReady) { throw 'Labnote did not become ready. Check data/server-error.log.' }
}
if (-not $NoBrowser) { Start-Process $labnoteAddress }
Write-Output $labnoteAddress
