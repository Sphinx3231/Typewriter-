# Real operating-system input and screen capture for the Windows end-to-end test.
#   input.ps1 click X Y        a real left click at screen coordinates
#   input.ps1 stopkeys         presses Ctrl+Shift+Space (Typewriter's emergency stop)
#   input.ps1 shot FILE.png    captures the whole primary screen
#   input.ps1 fg               prints the title of the foreground window
#   input.ps1 find TITLE       prints "x y w h" of the visible top-level window with that exact title
#   input.ps1 hideconsoles     minimizes visible console windows (on the CI runner a stray
#                              msedgewebview2.exe console can sit on top of the target windows)
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
[TwInput]::SetProcessDPIAware() | Out-Null
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
}
