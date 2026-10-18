# Real operating-system input and screen capture for the Windows end-to-end test.
#   input.ps1 click X Y        a real left click at screen coordinates
#   input.ps1 stopkeys         presses Ctrl+Shift+Space (Typewriter's emergency stop)
#   input.ps1 shot FILE.png    captures the whole primary screen
#   input.ps1 fg               prints the title of the foreground window
#   input.ps1 find TITLE       prints "x y w h" of the visible top-level window with that exact title
#   input.ps1 findclass CLASS  like find, by window class (Notepad's title changes as you type)
#   input.ps1 notepadtext      prints the text in Notepad's edit box
#   input.ps1 capture TITLE F  captures the screen area of that window to F.png and prints
#                              "width height colours dominantShare base64png" (is it painted?)
#   input.ps1 keys ctrltab     presses Ctrl+Tab (next browser tab)
#   input.ps1 minimize TITLE   minimizes that window
#   input.ps1 iconic TITLE     prints True when that window is minimized
#   input.ps1 sysclose TITLE   asks that window to close, like the taskbar's "Close window"
#   input.ps1 hideconsoles     minimizes visible console windows (on the CI runner a stray
#                              msedgewebview2.exe console can sit on top of the target windows)
#   input.ps1 windows          lists visible top-level windows, top first: title, process, pid,
#                              process start time, parent process (who opened a stray dialog?)
#   input.ps1 closeforeign RE  closes visible windows whose title matches RE (a dialog the runner
#                              opened on its own and that covers the targets) and lists them
param([Parameter(Mandatory = $true)][string]$Cmd, [string]$A, [string]$B)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TwInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  // Visible top-level windows with a title, in z-order (top first).
  public static System.Collections.Generic.List<IntPtr> Visible() {
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && !IsIconic(h)) {
        var s = new StringBuilder(512);
        if (GetWindowText(h, s, 512) > 0) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
[TwInput]::SetProcessDPIAware() | Out-Null
function Find-Window([string]$title) {
  $h = [TwInput]::FindWindow([NullString]::Value, $title)
  if ($h -eq [IntPtr]::Zero) {
    $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $title } | Select-Object -First 1
    if ($p) { $h = $p.MainWindowHandle }
  }
  return $h
}
function Describe-Window([IntPtr]$h) {
  $s = New-Object System.Text.StringBuilder 512
  [TwInput]::GetWindowText($h, $s, 512) | Out-Null
  $procId = [uint32]0
  [TwInput]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
  $parent = if ($p) { Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue }
  $started = if ($p -and $p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString("HH:mm:ss") + " UTC" } else { "?" }
  "`"$($s.ToString())`" · $(if ($p) { $p.Name } else { '?' }) (pid $procId, started $started, parent $(if ($parent) { "$($parent.Name) pid $($parent.ProcessId)" } else { '?' }))"
}
switch ($Cmd) {
  "click" {
    [TwInput]::SetCursorPos([int]$A, [int]$B) | Out-Null
    Start-Sleep -Milliseconds 60
    [TwInput]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
    [TwInput]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  }
  "stopkeys" {
    foreach ($k in 0x11, 0x10, 0x20) { [TwInput]::keybd_event($k, 0, 0, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 80
    foreach ($k in 0x20, 0x10, 0x11) { [TwInput]::keybd_event($k, 0, 0x2, [UIntPtr]::Zero) }
  }
  "shot" {
    # Screen size from Win32 (Screen.PrimaryScreen is null in some non-interactive sessions).
    Add-Type -AssemblyName System.Drawing
    $w = [TwInput]::GetSystemMetrics(0); $h = [TwInput]::GetSystemMetrics(1)
    $bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size ([int]$w), ([int]$h)))
    $bmp.Save($A, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
  }
  "fg" {
    $s = New-Object System.Text.StringBuilder 512
    [TwInput]::GetWindowText([TwInput]::GetForegroundWindow(), $s, 512) | Out-Null
    $s.ToString()
  }
  "hideconsoles" {
    $h = [IntPtr]::Zero
    while (($h = [TwInput]::FindWindowEx([IntPtr]::Zero, $h, "ConsoleWindowClass", [NullString]::Value)) -ne [IntPtr]::Zero) {
      if ([TwInput]::IsWindowVisible($h)) {
        $s = New-Object System.Text.StringBuilder 512
        [TwInput]::GetWindowText($h, $s, 512) | Out-Null
        [TwInput]::ShowWindow($h, 6) | Out-Null
        "minimized console: $($s.ToString())"
      }
    }
  }
  "findclass" {
    $h = [TwInput]::FindWindow($A, [NullString]::Value)
    if ($h -ne [IntPtr]::Zero -and [TwInput]::IsWindowVisible($h)) {
      $r = New-Object TwInput+RECT
      [TwInput]::GetWindowRect($h, [ref]$r) | Out-Null
      "$($r.L) $($r.T) $($r.R - $r.L) $($r.B - $r.T)"
    }
  }
  "notepadtext" {
    $h = [TwInput]::FindWindow("Notepad", [NullString]::Value)
    if ($h -eq [IntPtr]::Zero) { exit 2 }
    $e = [TwInput]::FindWindowEx($h, [IntPtr]::Zero, "Edit", [NullString]::Value)
    if ($e -eq [IntPtr]::Zero) { $e = [TwInput]::FindWindowEx($h, [IntPtr]::Zero, "RichEditD2DPT", [NullString]::Value) }
    if ($e -eq [IntPtr]::Zero) { exit 3 }
    $n = [TwInput]::SendMessage($e, 0x0E, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    $sb = New-Object System.Text.StringBuilder ($n + 1)
    [TwInput]::SendMessage($e, 0x0D, [IntPtr]($n + 1), $sb) | Out-Null
    # Base64, so line breaks and non-ASCII survive the console.
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
  }
  "find" {
    # [NullString]: PowerShell would pass $null as "" (no window has class ""), and find nothing.
    $h = [TwInput]::FindWindow([NullString]::Value, $A)
    if ($h -eq [IntPtr]::Zero) {
      $p = Get-Process | Where-Object { $_.MainWindowTitle -eq $A } | Select-Object -First 1
      if ($p) { $h = $p.MainWindowHandle }
    }
    if ($h -ne [IntPtr]::Zero -and [TwInput]::IsWindowVisible($h)) {
      $r = New-Object TwInput+RECT
      [TwInput]::GetWindowRect($h, [ref]$r) | Out-Null
      "$($r.L) $($r.T) $($r.R - $r.L) $($r.B - $r.T)"
    }
  }
  "capture" {
    $h = Find-Window $A
    if ($h -eq [IntPtr]::Zero) { exit 2 }
    $r = New-Object TwInput+RECT
    [TwInput]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $hh = $r.B - $r.T
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$hh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size ([int]$w), ([int]$hh)))
    $bmp.Save($B, [System.Drawing.Imaging.ImageFormat]::Png)
    # Colours (4 bits per channel) and the share of the most common one: a blank window has one colour.
    $counts = @{}
    for ($y = 0; $y -lt $hh; $y += 2) {
      for ($x = 0; $x -lt $w; $x += 2) {
        $c = $bmp.GetPixel($x, $y)
        $k = (($c.R -shr 4) -shl 8) -bor (($c.G -shr 4) -shl 4) -bor ($c.B -shr 4)
        $counts[$k] = 1 + [int]$counts[$k]
      }
    }
    $total = 0; $top = 0
    foreach ($v in $counts.Values) { $total += $v; if ($v -gt $top) { $top = $v } }
    $g.Dispose(); $bmp.Dispose()
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($B))
    "$w $hh $($counts.Count) $([math]::Round($top / [math]::Max(1, $total), 4)) $b64"
  }
  "keys" {
    if ($A -eq "ctrltab") {
      [TwInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
      [TwInput]::keybd_event(0x09, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [TwInput]::keybd_event(0x09, 0, 0x2, [UIntPtr]::Zero)
      [TwInput]::keybd_event(0x11, 0, 0x2, [UIntPtr]::Zero)
    }
  }
  "minimize" {
    $h = Find-Window $A
    if ($h -eq [IntPtr]::Zero) { exit 2 }
    [TwInput]::ShowWindow($h, 6) | Out-Null
  }
  "iconic" {
    $h = Find-Window $A
    if ($h -eq [IntPtr]::Zero) { exit 2 }
    [TwInput]::IsIconic($h)
  }
  "sysclose" {
    # WM_SYSCOMMAND SC_CLOSE: what the taskbar's "Close window" and the title bar's X send.
    $h = Find-Window $A
    if ($h -eq [IntPtr]::Zero) { exit 2 }
    [TwInput]::PostMessage($h, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero) | Out-Null
  }
  "windows" {
    foreach ($h in [TwInput]::Visible()) { Describe-Window $h }
  }
  "closeforeign" {
    foreach ($h in [TwInput]::Visible()) {
      $s = New-Object System.Text.StringBuilder 512
      [TwInput]::GetWindowText($h, $s, 512) | Out-Null
      if ($s.ToString() -match $A) {
        "closed a window the test didn't open: $(Describe-Window $h)"
        [TwInput]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      }
    }
  }
}
