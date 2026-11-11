# notaboek-cleanup.ps1
# Trims the "Open with" suggestions for .md and .txt down to Notepad and Notaboek,
# and registers Notaboek so it appears in the Windows default-app picker.
#
# Run once without -Apply to see what would change (nothing is touched):
#   powershell -ExecutionPolicy Bypass -File .\notaboek-cleanup.ps1
# Then run it for real:
#   powershell -ExecutionPolicy Bypass -File .\notaboek-cleanup.ps1 -Apply
#
# Only your own user settings (HKCU) are changed. A backup of every key it edits
# is written to Desktop\open-with-backup first. Double-click a .reg file there to undo.

param([switch]$Apply)

$exts        = '.md', '.txt'
$keepPattern = 'notepad|notaboek'
$notaboekExe = Join-Path $env:LOCALAPPDATA 'Programs\Notaboek\Notaboek.exe'
$backupDir   = Join-Path ([Environment]::GetFolderPath('Desktop')) 'open-with-backup'

function Describe-ProgId([string]$progId) {
    $parts = @($progId)
    foreach ($root in 'HKCU:\Software\Classes', 'HKLM:\Software\Classes') {
        $app = Get-ItemProperty -LiteralPath "$root\$progId\Application" -ErrorAction SilentlyContinue
        if ($app.ApplicationName) { $parts += $app.ApplicationName }
        $cmd = (Get-ItemProperty -LiteralPath "$root\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
        if ($cmd) { $parts += $cmd }
        $def = (Get-ItemProperty -LiteralPath "$root\$progId" -ErrorAction SilentlyContinue).'(default)'
        if ($def) { $parts += $def }
    }
    ($parts | Select-Object -Unique) -join ' | '
}

if ($Apply) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
}

foreach ($ext in $exts) {
    Write-Host "`n=== $ext ===" -ForegroundColor Cyan
    $fileExts = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext"
    $classes  = "HKCU:\Software\Classes\$ext"

    if ($Apply) {
        reg export "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext" "$backupDir\FileExts$ext.reg" /y 2>$null | Out-Null
        reg export "HKCU\Software\Classes\$ext" "$backupDir\Classes$ext.reg" /y 2>$null | Out-Null
    }

    # 1. Recently used programs (OpenWithList: values a, b, c... holding exe names)
    $owl = "$fileExts\OpenWithList"
    if (Test-Path -LiteralPath $owl) {
        $props = Get-ItemProperty -LiteralPath $owl
        $kept  = @()
        foreach ($p in $props.PSObject.Properties | Where-Object { $_.Name -cmatch '^[a-z]$' }) {
            if ($p.Value -match $keepPattern) {
                $kept += $p.Name
                Write-Host "KEEP    $($p.Value)" -ForegroundColor Green
            } else {
                Write-Host "REMOVE  $($p.Value)" -ForegroundColor Yellow
                if ($Apply) { Remove-ItemProperty -LiteralPath $owl -Name $p.Name }
            }
        }
        if ($Apply) { Set-ItemProperty -LiteralPath $owl -Name MRUList -Value (-join $kept) }
    }

    # 2. Registered handlers (OpenWithProgids), in both per-user locations
    foreach ($key in "$fileExts\OpenWithProgids", "$classes\OpenWithProgids") {
        if (-not (Test-Path -LiteralPath $key)) { continue }
        foreach ($name in (Get-Item -LiteralPath $key).GetValueNames()) {
            if (-not $name) { continue }
            $desc = Describe-ProgId $name
            if ($desc -match $keepPattern) {
                Write-Host "KEEP    $desc" -ForegroundColor Green
            } else {
                Write-Host "REMOVE  $desc" -ForegroundColor Yellow
                if ($Apply) { Remove-ItemProperty -LiteralPath $key -Name $name }
            }
        }
    }

    # 3. Machine-wide handlers need admin rights, so they are only reported
    $hklm = "HKLM:\Software\Classes\$ext\OpenWithProgids"
    if (Test-Path -LiteralPath $hklm) {
        foreach ($name in (Get-Item -LiteralPath $hklm).GetValueNames()) {
            if (-not $name) { continue }
            $desc = Describe-ProgId $name
            if ($desc -notmatch $keepPattern) {
                Write-Host "MACHINE-WIDE, NOT CHANGED  $desc" -ForegroundColor DarkGray
            }
        }
    }
}

# 4. Register Notaboek so the picker lists it for .md and .txt
Write-Host "`n=== Notaboek ===" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $notaboekExe)) {
    Write-Host "Notaboek.exe not found at $notaboekExe, skipping registration." -ForegroundColor Red
} else {
    Write-Host "REGISTER $notaboekExe for $($exts -join ', ')" -ForegroundColor Green
    if ($Apply) {
        reg export "HKCU\Software\Classes\Applications\Notaboek.exe" "$backupDir\Applications-Notaboek.reg" /y 2>$null | Out-Null
        $appKey = 'HKCU:\Software\Classes\Applications\Notaboek.exe'
        New-Item -Path "$appKey\shell\open\command" -Force -Value "`"$notaboekExe`" `"%1`"" | Out-Null
        New-Item -Path "$appKey\SupportedTypes" -Force | Out-Null
        foreach ($ext in $exts) {
            New-ItemProperty -LiteralPath "$appKey\SupportedTypes" -Name $ext -Value '' -PropertyType String -Force | Out-Null
            New-Item -Path "HKCU:\Software\Classes\$ext\OpenWithList\Notaboek.exe" -Force | Out-Null
        }
    }
}

if ($Apply) {
    Write-Host "`nDone. Backups are in $backupDir" -ForegroundColor Cyan
} else {
    Write-Host "`nDry run only. Re-run with -Apply to make these changes." -ForegroundColor Cyan
}