# banner.ps1 — "ClawdCursor — desktop control in progress" indicator.
#
# A small, always-on-top, borderless pill at the top-center of the primary
# screen with a blinking red "recording" dot. Shown by the daemon while an
# agent is actively driving the desktop, so a human at the machine ALWAYS
# knows automation is live (transparency requirement — same spirit as the
# labeled agent browser window).
#
# Interaction contract with the parent (src/core/banner.ts):
#   - Parent spawns:  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File banner.ps1
#   - DOUBLE-CLICK anywhere on the banner → prints "BANNER_STOP" on stdout and
#     exits; the parent reacts by running the `clawdcursor stop` flow
#     (abort in-flight task + graceful daemon shutdown).
#   - Parent kills this process to hide the banner.
#
# CRITICAL: the window must NEVER steal focus — it appears WHILE the agent is
# typing/clicking, and an activating window would redirect those keystrokes
# (the exact focus-theft bug class fixed in v1.5.1). WS_EX_NOACTIVATE +
# ShowWithoutActivation make it a zero-focus overlay; clicks still reach it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Windows.Forms;

public class NoActivateBannerForm : Form {
    // Never take focus when shown…
    protected override bool ShowWithoutActivation { get { return true; } }
    // …or when clicked. WS_EX_NOACTIVATE (0x08000000) + WS_EX_TOPMOST (0x8).
    protected override CreateParams CreateParams {
        get {
            CreateParams p = base.CreateParams;
            p.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            p.ExStyle |= 0x00000008; // WS_EX_TOPMOST
            return p;
        }
    }
}
'@

$form = New-Object NoActivateBannerForm
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = 'Manual'
$form.BackColor       = [System.Drawing.Color]::FromArgb(18, 18, 26)
$form.Size            = New-Object System.Drawing.Size(430, 40)

# Top-center of the primary screen, 8px below the edge.
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(
    [int]($screen.X + ($screen.Width - $form.Width) / 2), [int]($screen.Y + 8))

# Rounded pill region.
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 18; $w = $form.Width; $h = $form.Height
$gp.AddArc(0, 0, $r*2, $r*2, 180, 90)
$gp.AddArc($w - $r*2, 0, $r*2, $r*2, 270, 90)
$gp.AddArc($w - $r*2, $h - $r*2, $r*2, $r*2, 0, 90)
$gp.AddArc(0, $h - $r*2, $r*2, $r*2, 90, 90)
$gp.CloseFigure()
$form.Region = New-Object System.Drawing.Region($gp)

$dot = New-Object System.Windows.Forms.Label
$dot.Text      = [char]0x25CF  # ●
$dot.Font      = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 59, 48)
$dot.BackColor = [System.Drawing.Color]::Transparent
$dot.AutoSize  = $true
$dot.Location  = New-Object System.Drawing.Point(14, 5)

$text = New-Object System.Windows.Forms.Label
$text.Text      = 'ClawdCursor '  # brand
$text.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$text.ForeColor = [System.Drawing.Color]::White
$text.BackColor = [System.Drawing.Color]::Transparent
$text.AutoSize  = $true
$text.Location  = New-Object System.Drawing.Point(40, 10)

$sub = New-Object System.Windows.Forms.Label
$sub.Text      = 'desktop control in progress  -  double-click to stop'
$sub.Font      = New-Object System.Drawing.Font('Segoe UI', 9)
$sub.ForeColor = [System.Drawing.Color]::FromArgb(170, 170, 185)
$sub.BackColor = [System.Drawing.Color]::Transparent
$sub.AutoSize  = $true
$sub.Location  = New-Object System.Drawing.Point(133, 11)

$form.Controls.AddRange(@($dot, $text, $sub))

# Recording blink — bright/dim every 600ms.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 600
$bright = $true
$timer.Add_Tick({
    $script:bright = -not $script:bright
    if ($script:bright) { $dot.ForeColor = [System.Drawing.Color]::FromArgb(255, 59, 48) }
    else                { $dot.ForeColor = [System.Drawing.Color]::FromArgb(110, 25, 20) }
})
$timer.Start()

$stopHandler = {
    [Console]::Out.WriteLine('BANNER_STOP')
    [Console]::Out.Flush()
    $form.Close()
}
$form.Add_MouseDoubleClick($stopHandler)
foreach ($c in @($dot, $text, $sub)) { $c.Add_MouseDoubleClick($stopHandler) }

[System.Windows.Forms.Application]::Run($form)
