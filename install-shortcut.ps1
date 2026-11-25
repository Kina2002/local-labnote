$ErrorActionPreference = 'Stop'
$appDirectory = $PSScriptRoot
$exe = Get-ChildItem -LiteralPath $appDirectory -Filter 'Labnote*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($exe) {
    $target = $exe.FullName
    $arguments = ''
} else {
    $python = (Get-Command python -ErrorAction Stop).Source
    $target = Join-Path (Split-Path $python) 'pythonw.exe'
    if (-not (Test-Path -LiteralPath $target)) {
        throw 'pythonw.exe is required.'
    }
    $arguments = '"' + (Join-Path $appDirectory 'app.py') + '"'
}
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$appName = -join [char[]]@(0xC804, 0xC790, 0xB7A9, 0xB178, 0xD2B8)
$shortcutPath = Join-Path $programs ($appName + '.lnk')
$pinnedPath = Join-Path (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar') ($appName + '.lnk')
$temporaryPath = Join-Path $appDirectory 'shortcut-build.lnk'
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($temporaryPath)
    $shortcut.TargetPath = $target
    $shortcut.Arguments = $arguments
    $shortcut.WorkingDirectory = $appDirectory
    $shortcut.Description = 'Local research notebook desktop app'
    $shortcut.Save()
    if (-not $shell.CreateShortcut($temporaryPath).TargetPath) {
        throw 'Shortcut target was not saved.'
    }
    Copy-Item -LiteralPath $temporaryPath -Destination $shortcutPath -Force
    if (Test-Path -LiteralPath $pinnedPath) {
        Copy-Item -LiteralPath $temporaryPath -Destination $pinnedPath -Force
    }
} finally {
    Remove-Item -LiteralPath $temporaryPath -ErrorAction SilentlyContinue
}
if (-not $shell.CreateShortcut($shortcutPath).TargetPath) {
    throw 'Shortcut target could not be verified.'
}
if ((Test-Path -LiteralPath $pinnedPath) -and $shell.CreateShortcut($pinnedPath).TargetPath -ne $target) {
    throw 'Pinned shortcut target could not be verified.'
}
Write-Output $shortcutPath
