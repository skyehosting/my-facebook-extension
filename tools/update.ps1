# My Facebook - updater
# Downloads the latest version from GitHub into this extension's folder.
# Run it by double-clicking "Update My Facebook.bat" one folder up.
#
# The extension notices the new files by itself and reloads (unless that is turned
# off in its popup). Nothing outside this folder is changed.

$ErrorActionPreference = 'Stop'
$repo = 'skyehosting/my-facebook-extension'
$branch = 'main'
$root = Split-Path -Parent $PSScriptRoot   # the extension folder (this script lives in tools\)

function Get-ExtensionVersion([string]$folder) {
    $manifest = Join-Path $folder 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifest)) { return $null }
    return (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
}

function Wait-BeforeClosing {
    # Keep the window open when started by double-click; skip when run from a script.
    if ($env:MY_FACEBOOK_UPDATE_NO_PAUSE -ne '1') {
        Write-Host ''
        Read-Host 'Press Enter to close this window' | Out-Null
    }
}

try {
    $before = Get-ExtensionVersion $root
    if (-not $before) { throw "This does not look like the extension folder: $root" }
    Write-Host "My Facebook updater"
    Write-Host "Folder:            $root"
    Write-Host "Installed version: $before"
    Write-Host ''

    if (Test-Path -LiteralPath (Join-Path $root '.git')) {
        # A git checkout (for people working on the extension): just pull.
        Write-Host 'This folder is a git checkout, running: git pull --ff-only'
        & git -C $root pull --ff-only
        if ($LASTEXITCODE -ne 0) { throw 'git pull did not succeed. Resolve it in git, then try again.' }
    }
    else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $temp = Join-Path ([IO.Path]::GetTempPath()) ('my-facebook-update-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $temp | Out-Null
        try {
            $zip = Join-Path $temp 'latest.zip'
            Write-Host "Downloading the latest version from github.com/$repo ..."
            Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/heads/$branch.zip" -OutFile $zip -UseBasicParsing
            Expand-Archive -LiteralPath $zip -DestinationPath $temp
            $source = Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1
            $latest = if ($source) { Get-ExtensionVersion $source.FullName } else { $null }
            if (-not $latest) { throw 'The download did not contain the extension.' }
            if ($latest -eq $before) {
                Write-Host "You already have the latest version ($before). Nothing to do."
                Wait-BeforeClosing
                exit 0
            }
            Copy-Item -Path (Join-Path $source.FullName '*') -Destination $root -Recurse -Force
        }
        finally {
            Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $after = Get-ExtensionVersion $root
    Write-Host ''
    if ($after -eq $before) {
        Write-Host "You already have the latest version ($before). Nothing to do."
    }
    else {
        Write-Host "Updated from $before to $after."
        Write-Host 'Open or refresh Facebook: the extension loads the new version by itself.'
        Write-Host 'If you turned that off, open the My Facebook popup and press "Load it now".'
    }
    Wait-BeforeClosing
    exit 0
}
catch {
    Write-Host ''
    Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "You can also update by hand: download https://github.com/$repo/archive/refs/heads/$branch.zip,"
    Write-Host 'unzip it over this folder, then reload the extension on the extensions page.'
    Wait-BeforeClosing
    exit 1
}
