# Clawd Cursor Installer for Windows
# Usage: powershell -c "irm https://clawdcursor.com/install.ps1 | iex"
# Specify version: $env:VERSION='v0.9.9'; irm https://clawdcursor.com/install.ps1 | iex

$ErrorActionPreference = "Continue"
$VERSION = if ($env:VERSION) { $env:VERSION } else { "main" }
$INSTALL_DIR = "$HOME\clawdcursor"

Write-Host ""
Write-Host "  /\___/\" -ForegroundColor Green
Write-Host " ( >^.^< )  Clawd Cursor Installer" -ForegroundColor Green
Write-Host "  )     (" -ForegroundColor Green
Write-Host " (_)_(_)_)" -ForegroundColor Green
Write-Host ""

# ── 1. Check Node.js ─────────────────────────────────────────────────────────
$nodeVersion = $null
try { $nodeVersion = (node --version 2>$null) } catch {}
if (-not $nodeVersion) {
    Write-Host "  [X] Node.js not found. Get it from https://nodejs.org (v20+)" -ForegroundColor Red
    exit 1
}
$major = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
if ($major -lt 20) {
    Write-Host "  [X] Node.js $nodeVersion is too old. Update to v20+: https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] Node.js $nodeVersion" -ForegroundColor Green

# ── 2. Check git ──────────────────────────────────────────────────────────────
$gitVer = $null
try { $gitVer = (git --version 2>$null) } catch {}
if (-not $gitVer) {
    Write-Host "  [X] git not found. Get it from https://git-scm.com" -ForegroundColor Red
    exit 1
}
Write-Host "  [OK] $gitVer" -ForegroundColor Green

# ── 3. Clone or update ───────────────────────────────────────────────────────
Write-Host ""
$DISPLAY_VERSION = if ($VERSION -eq "main") { "latest (main)" } else { $VERSION }

if (Test-Path "$INSTALL_DIR\.git") {
    # Update existing install -- only proceed if the working tree is clean.
    # The previous "git checkout && pull || rm -rf" path silently destroyed
    # user state when git complained (dirty tree, diverged history, etc.).
    Write-Host "  Updating to $DISPLAY_VERSION..." -ForegroundColor Cyan
    Push-Location $INSTALL_DIR

    $dirty = git status --porcelain 2>$null
    if ($dirty) {
        Pop-Location
        Write-Host "  [X] Refusing to update: $INSTALL_DIR has uncommitted changes." -ForegroundColor Red
        Write-Host ""
        $dirtyLines = @($dirty -split "`r?`n" | Where-Object { $_ })
        foreach ($line in ($dirtyLines | Select-Object -First 20)) { Write-Host "      $line" }
        if ($dirtyLines.Count -gt 20) { Write-Host "      ... and $($dirtyLines.Count - 20) more" }
        Write-Host ""
        Write-Host "  Pick one and re-run the installer:" -ForegroundColor Yellow
        Write-Host "    - Stash:    Push-Location $INSTALL_DIR; git stash; Pop-Location"
        Write-Host "    - Discard:  Push-Location $INSTALL_DIR; git reset --hard; git clean -fd; Pop-Location"
        Write-Host "    - Sidecar:  `$env:INSTALL_DIR='$HOME\clawdcursor-new'; irm https://clawdcursor.com/install.ps1 | iex"
        exit 1
    }

    $fetchErr = (git fetch --all --tags --quiet 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "  [X] Failed to fetch from GitHub (network or auth issue):" -ForegroundColor Red
        foreach ($line in ($fetchErr -split "`r?`n" | Where-Object { $_ })) { Write-Host "      $line" }
        exit 1
    }

    $coErr = (git checkout $VERSION --quiet 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Pop-Location
        Write-Host "  [X] Failed to switch to '$VERSION':" -ForegroundColor Red
        foreach ($line in ($coErr -split "`r?`n" | Where-Object { $_ })) { Write-Host "      $line" }
        Write-Host "      (tree is clean -- likely the ref doesn't exist on origin)"
        exit 1
    }

    # Only pull if we landed on a branch; tag/SHA checkouts are detached.
    git symbolic-ref -q HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $pullErr = (git pull --ff-only --quiet 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Host "  [X] Failed to fast-forward '$VERSION':" -ForegroundColor Red
            foreach ($line in ($pullErr -split "`r?`n" | Where-Object { $_ })) { Write-Host "      $line" }
            Write-Host "      Local branch may have diverged from origin. Resolve manually."
            exit 1
        }
    }
    Pop-Location
} elseif (Test-Path $INSTALL_DIR) {
    # Directory exists but isn't a git checkout. Could be user data we
    # don't recognise -- refuse rather than silently Remove-Item -Force.
    Write-Host "  [X] $INSTALL_DIR exists but is not a git checkout." -ForegroundColor Red
    Write-Host "      Move or remove it manually, then re-run. (We won't delete"
    Write-Host "      it for you because it might contain unrelated files.)"
    exit 1
} else {
    Write-Host "  Downloading $DISPLAY_VERSION..." -ForegroundColor Cyan
    $cloneErr = (git clone https://github.com/AmrDab/clawdcursor.git --branch $VERSION $INSTALL_DIR --quiet 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [X] Clone failed:" -ForegroundColor Red
        foreach ($line in ($cloneErr -split "`r?`n" | Where-Object { $_ })) { Write-Host "      $line" }
        exit 1
    }
}

# ── 4. Install dependencies ──────────────────────────────────────────────────
Write-Host "  Installing dependencies..." -ForegroundColor Cyan
Push-Location $INSTALL_DIR
$output = npm install --loglevel error 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] npm install failed. Run manually: cd $INSTALL_DIR; npm install" -ForegroundColor Red
    Pop-Location; exit 1
}

# ── 5. Build ──────────────────────────────────────────────────────────────────
Write-Host "  Building..." -ForegroundColor Cyan
$output = npm run build 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Build failed. Run manually: cd $INSTALL_DIR; npm run build" -ForegroundColor Red
    Pop-Location; exit 1
}

# ── 6. Link (with pre-cleanup to avoid EEXIST) ───────────────────────────────
Write-Host "  Linking..." -ForegroundColor Cyan
$npmPrefix = (npm prefix -g 2>$null)
if ($npmPrefix) {
    $npmPrefix = $npmPrefix.Trim()
    # Remove old shims -- prevents EEXIST errors on re-install
    foreach ($ext in @('', '.cmd', '.ps1')) {
        $shimPath = "$npmPrefix\clawdcursor$ext"
        if (Test-Path $shimPath) { Remove-Item -Force $shimPath 2>$null }
    }
    # Remove old junction safely (cmd rmdir won't follow into target)
    $junctionPath = "$npmPrefix\node_modules\clawdcursor"
    if (Test-Path $junctionPath) {
        cmd /c "rmdir `"$junctionPath`"" 2>$null
    }
}
$output = npm link --force 2>&1 | Out-String
Pop-Location

# ── 7. Verify ─────────────────────────────────────────────────────────────────
# Refresh PATH so we can find the newly linked command
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

$exe = Get-Command clawdcursor -ErrorAction SilentlyContinue
Write-Host ""
if ($exe) {
    $ver = & clawdcursor --version 2>$null
    Write-Host "  [OK] Clawd Cursor $ver installed!" -ForegroundColor Green
} else {
    # Diagnose: is npm prefix in PATH?
    if ($npmPrefix) {
        $inPath = $env:Path -split ';' | Where-Object { $_ -eq $npmPrefix }
        if (-not $inPath) {
            Write-Host "  [OK] Installed, but npm's bin folder is not in your PATH." -ForegroundColor Yellow
            Write-Host "       Add this to your system PATH, then reopen your terminal:" -ForegroundColor Yellow
            Write-Host "       $npmPrefix" -ForegroundColor White
        } else {
            Write-Host "  [OK] Installed! Close and reopen your terminal to use 'clawdcursor'." -ForegroundColor Green
        }
    } else {
        Write-Host "  [OK] Installed to $INSTALL_DIR" -ForegroundColor Green
        Write-Host "       Reopen your terminal to use 'clawdcursor'." -ForegroundColor Yellow
    }
}

# Detect whether the user already accepted consent on a prior install.
# Saves them from being told to re-run a one-time step they already did.
$consentGiven = Test-Path "$HOME\.clawdcursor\consent"
$configPresent = Test-Path "$INSTALL_DIR\.clawdcursor-config.json"

Write-Host ""
if (-not $consentGiven) {
    Write-Host "  Start here:" -ForegroundColor Cyan
    Write-Host "    clawdcursor consent     " -NoNewline -ForegroundColor Yellow
    Write-Host "One-time desktop control authorization" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Then pick a path:" -ForegroundColor Cyan
} else {
    Write-Host "  [OK] Consent already accepted from a previous install." -ForegroundColor Green
    Write-Host ""
    Write-Host "  Pick a path:" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "    Autonomous agent" -NoNewline -ForegroundColor White
Write-Host " (clawdcursor brings the AI brain):" -ForegroundColor Gray
if ($configPresent) {
    Write-Host "      Config already saved -- skip step 1 unless you want to reconfigure." -ForegroundColor DarkGray
    Write-Host "      1. clawdcursor doctor   " -NoNewline -ForegroundColor DarkYellow
    Write-Host "(optional) Re-check / change AI provider + models" -ForegroundColor Gray
} else {
    Write-Host "      1. clawdcursor doctor   " -NoNewline -ForegroundColor Yellow
    Write-Host "Configure AI provider + models" -ForegroundColor Gray
}
Write-Host "      2. clawdcursor agent    " -NoNewline -ForegroundColor Yellow
Write-Host "Start the daemon (HTTP + MCP on :3847)" -ForegroundColor Gray
Write-Host ""
Write-Host "    MCP-only" -NoNewline -ForegroundColor White
Write-Host " (your editor brings the AI brain):" -ForegroundColor Gray
Write-Host "      Register " -NoNewline -ForegroundColor Gray
Write-Host "clawdcursor mcp" -NoNewline -ForegroundColor Yellow
Write-Host " with Claude Code, Cursor, Windsurf, Zed, etc." -ForegroundColor Gray
Write-Host "      No daemon, no API key in clawdcursor -- your editor handles both." -ForegroundColor Gray
Write-Host ""
Write-Host "  Run now:" -ForegroundColor White
if (-not $consentGiven) {
    Write-Host "    clawdcursor consent" -ForegroundColor Yellow
} elseif (-not $configPresent) {
    Write-Host "    clawdcursor doctor" -ForegroundColor Yellow
} else {
    Write-Host "    clawdcursor agent" -ForegroundColor Yellow
}
Write-Host ""
