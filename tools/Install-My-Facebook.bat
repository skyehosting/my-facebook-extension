@echo off
rem My Facebook - installer for Windows (Brave, Chrome, Edge, Vivaldi, Opera and other Chromium browsers).
rem Double-click this file. Everything below the marker line is PowerShell, run from this same file.
setlocal
title My Facebook - Installer
set "MF_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText($env:MF_SELF); $m = '#:PS-' + 'START:#'; Invoke-Expression $t.Substring($t.IndexOf($m))"
exit /b %errorlevel%

#:PS-START:#
# ---------------------------------------------------------------------------------------
# What this does:
#   1. Downloads the extension from GitHub into a folder that stays put
#      (%LOCALAPPDATA%\My Facebook). Running it again updates that folder.
#   2. Finds your Chromium-based browser and opens a short guide page in it
#      (tools\install-guide.html, a file on this computer) with the steps that are left.
#   3. Puts the folder's path on the clipboard for the last of those steps.
#
# Why it cannot do those last clicks: Chromium browsers refuse to let any program add an
# extension that does not come from their store, or even open their Extensions page.
# Only you can, in the browser.
# Nothing else on the computer is changed, and nothing is installed system-wide.
# ---------------------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$repo = 'skyehosting/my-facebook-extension'
$branch = 'main'
$target = if ($env:MY_FACEBOOK_INSTALL_DIR) { $env:MY_FACEBOOK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'My Facebook' }
$quiet = $env:MY_FACEBOOK_INSTALL_TEST -eq '1'   # test runs: no clipboard, no browser, no questions

function Get-ExtensionVersion([string]$folder) {
    $manifest = Join-Path $folder 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    return (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
}

function Wait-BeforeClosing {
    if (-not $quiet) {
        Write-Host ''
        Read-Host 'Press Enter to close this window' | Out-Null
    }
}

function Find-Browsers {
    $pf = $env:ProgramFiles
    $pf86 = ${env:ProgramFiles(x86)}
    $la = $env:LOCALAPPDATA
    $known = @(
        @{ Name = 'Brave';          ProgId = 'BraveHTML';   Page = 'brave://extensions';   Paths = @("$pf\BraveSoftware\Brave-Browser\Application\brave.exe", "$pf86\BraveSoftware\Brave-Browser\Application\brave.exe", "$la\BraveSoftware\Brave-Browser\Application\brave.exe") },
        @{ Name = 'Google Chrome';  ProgId = 'ChromeHTML';  Page = 'chrome://extensions';  Paths = @("$pf\Google\Chrome\Application\chrome.exe", "$pf86\Google\Chrome\Application\chrome.exe", "$la\Google\Chrome\Application\chrome.exe") },
        @{ Name = 'Microsoft Edge'; ProgId = 'MSEdgeHTM';   Page = 'edge://extensions';    Paths = @("$pf86\Microsoft\Edge\Application\msedge.exe", "$pf\Microsoft\Edge\Application\msedge.exe") },
        @{ Name = 'Vivaldi';        ProgId = 'VivaldiHTM';  Page = 'vivaldi://extensions'; Paths = @("$la\Vivaldi\Application\vivaldi.exe", "$pf\Vivaldi\Application\vivaldi.exe") },
        @{ Name = 'Opera';          ProgId = 'OperaStable'; Page = 'opera://extensions';   Paths = @("$la\Programs\Opera\opera.exe", "$pf\Opera\opera.exe") },
        @{ Name = 'Chromium';       ProgId = 'ChromiumHTM'; Page = 'chrome://extensions';  Paths = @("$la\Chromium\Application\chrome.exe") }
    )
    $found = @()
    foreach ($b in $known) {
        $exe = $b.Paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
        if ($exe) { $found += [pscustomobject]@{ Name = $b.Name; ProgId = $b.ProgId; Page = $b.Page; Exe = $exe } }
    }
    return $found
}

function Select-Browser($found) {
    if (-not $found -or $found.Count -eq 0) { return $null }
    # Prefer the browser Windows opens web links with, when it is one of them.
    $default = $null
    try { $default = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction Stop).ProgId } catch { }
    if ($default) {
        $match = $found | Where-Object { $default -like ($_.ProgId + '*') } | Select-Object -First 1
        if ($match) { return $match }
    }
    if ($found.Count -eq 1 -or $quiet) { return $found[0] }
    Write-Host 'Which browser do you use for Facebook?'
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host ("  {0}. {1}" -f ($i + 1), $found[$i].Name) }
    $answer = Read-Host 'Type the number and press Enter'
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $found.Count) { return $found[$n - 1] }
    return $found[0]
}

try {
    Write-Host 'My Facebook - installer'
    Write-Host '-----------------------'
    Write-Host ''
    $before = Get-ExtensionVersion $target

    # 1. Download and unpack
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('my-facebook-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temp | Out-Null
    try {
        $zip = Join-Path $temp 'latest.zip'
        Write-Host "Downloading My Facebook from github.com/$repo ..."
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive -LiteralPath $zip -DestinationPath $temp
        $source = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
        $latest = if ($source) { Get-ExtensionVersion $source.FullName } else { $null }
        if (-not $latest) { throw 'The download did not contain the extension.' }
        if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Path $target | Out-Null }
        Copy-Item -Path (Join-Path $source.FullName '*') -Destination $target -Recurse -Force
    }
    finally {
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
    $after = Get-ExtensionVersion $target
    if (-not $after) { throw "Could not write the extension to $target" }
    if ($before -and $before -ne $after) { Write-Host "Updated version $before to $after in:" }
    elseif ($before) { Write-Host "Version $after is already in:" }
    else { Write-Host "Version $after is now in:" }
    Write-Host "  $target"
    Write-Host ''

    # 2. Browser
    $browser = Select-Browser (Find-Browsers)
    if (-not $browser) {
        Write-Host 'No Chromium-based browser was found (Brave, Chrome, Edge, Vivaldi, Opera).' -ForegroundColor Yellow
        Write-Host 'My Facebook does not work in Firefox or Safari.'
        Write-Host 'If you do have one of those browsers, open its Extensions page yourself and follow the steps below.'
        Write-Host ''
    }

    $open = $true
    if ($before -and -not $quiet) {
        Write-Host 'If My Facebook is already loaded in your browser, there is nothing more to do:'
        Write-Host 'it switches to the new files by itself the next time you open Facebook.'
        Write-Host ''
        $open = (Read-Host 'Load it into a browser now? Type Y and press Enter, or just press Enter to finish') -match '^[Yy]'
        Write-Host ''
    }

    if ($open) {
        # 3. Clipboard, the guide page, and the steps only you can do
        $page = if ($browser) { $browser.Page } else { 'chrome://extensions' }
        $guide = Join-Path $target 'tools\install-guide.html'
        $guideUrl = ([Uri]$guide).AbsoluteUri + '#folder=' + [Uri]::EscapeDataString($target) + '&page=' + [Uri]::EscapeDataString($page)
        $opened = $false
        if (-not $quiet) {
            try { Set-Clipboard -Value $target } catch { }
            if ($browser -and (Test-Path -LiteralPath $guide)) {
                try { Start-Process -FilePath $browser.Exe -ArgumentList ('"' + $guideUrl + '"'); $opened = $true } catch { }
            }
        }
        Write-Host 'Almost done. Browsers do not let a program add an extension, so the last step is yours:' -ForegroundColor Cyan
        Write-Host ''
        if ($opened) { Write-Host "  $($browser.Name) has opened a page with these same steps and copy buttons." ; Write-Host '' }
        Write-Host "  1. In your browser, open a new tab, type  $page  in the address bar and press Enter."
        Write-Host '  2. Switch on "Developer mode" (top right of that page).'
        Write-Host '  3. Click "Load unpacked". In the folder window, click the address bar at the top,'
        Write-Host '     press Ctrl+V, press Enter, then click "Select Folder".'
        Write-Host '  4. Open facebook.com.'
        Write-Host ''
        if ($quiet) { Write-Host "  (test run) guide page: $guideUrl" ; Write-Host '' }
        Write-Host 'The folder is already on your clipboard:'
        Write-Host "  $target"
        Write-Host ''
        Write-Host 'Leave that folder where it is: the browser loads the extension from it.'
        Write-Host 'To update later, double-click "Update My Facebook.bat" in that folder, or run this installer again.'
    }
    Wait-BeforeClosing
    exit 0
}
catch {
    Write-Host ''
    Write-Host "Installing did not work: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "You can install by hand instead: https://github.com/$repo#install-by-hand"
    Wait-BeforeClosing
    exit 1
}
