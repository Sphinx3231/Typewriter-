# A plain native Windows text window (WinForms TextBox, a Win32 Edit control) for the
# Windows end-to-end test. It writes its current text to $Out every 150 ms so the test
# can compare what arrived with the source, and clears itself when "$Out.clear" appears.
param([Parameter(Mandatory = $true)][string]$Out, [string]$Title = "Target Notes", [int]$X = 40, [int]$Y = 140)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point($X, $Y)
$form.Size = New-Object System.Drawing.Size(560, 420)
# Stay above other windows (a console on the CI runner can otherwise cover the text box).
$form.TopMost = $true
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.AcceptsReturn = $true
$tb.AcceptsTab = $true
$tb.ScrollBars = "Vertical"
$tb.Dock = "Fill"
$tb.Font = New-Object System.Drawing.Font("Segoe UI", 12)
$form.Controls.Add($tb)
$utf8 = New-Object System.Text.UTF8Encoding $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
    if (Test-Path "$Out.clear") { $tb.Clear(); Remove-Item "$Out.clear" -ErrorAction SilentlyContinue }
    [System.IO.File]::WriteAllText($Out, $tb.Text, $utf8)
  })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
