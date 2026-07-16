[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$OwnProcessId,

  [ValidateRange(80, 1000)]
  [int]$IntervalMilliseconds = 120,

  [ValidateRange(1, 1024)]
  [int]$MaximumPlatforms = 256
)

$ErrorActionPreference = 'Stop'
$OutputLineByteLimit = 256 * 1024
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8

# Geometry is the complete privacy boundary of this helper. It does not call
# window-title, UI Automation, DOM, OCR, screen-capture, or content APIs.
$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

public static class WindowPlatformWatcher
{
    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TRANSPARENT = 0x00000020L;
    private const long WS_EX_TOOLWINDOW = 0x00000080L;
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    private const int DWMWA_CLOAKED = 14;
    private const uint MONITOR_DEFAULTTONEAREST = 2;
    private const int MinimumWidth = 160;
    private const int MinimumHeight = 80;
    private const int FullscreenTolerance = 2;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr state);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int Size;
        public RECT Monitor;
        public RECT WorkArea;
        public uint Flags;
    }

    public sealed class Geometry
    {
        public string hwnd { get; set; }
        public uint pid { get; set; }
        public int left { get; set; }
        public int top { get; set; }
        public int right { get; set; }
        public int bottom { get; set; }
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsZoomed(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr window, int index);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(
        IntPtr window,
        int attribute,
        out RECT value,
        int valueSize
    );

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(
        IntPtr window,
        int attribute,
        out int value,
        int valueSize
    );

    private static long GetExtendedStyle(IntPtr window)
    {
        return IntPtr.Size == 8
            ? GetWindowLongPtr64(window, GWL_EXSTYLE).ToInt64()
            : GetWindowLong32(window, GWL_EXSTYLE);
    }

    private static bool IsFullscreen(IntPtr window, RECT bounds)
    {
        IntPtr monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        if (monitor == IntPtr.Zero) return false;

        MONITORINFO info = new MONITORINFO();
        info.Size = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(monitor, ref info)) return false;

        return bounds.Left <= info.Monitor.Left + FullscreenTolerance
            && bounds.Top <= info.Monitor.Top + FullscreenTolerance
            && bounds.Right >= info.Monitor.Right - FullscreenTolerance
            && bounds.Bottom >= info.Monitor.Bottom - FullscreenTolerance;
    }

    public static Geometry[] Scan(int ownProcessId, int maximumPlatforms)
    {
        List<Geometry> results = new List<Geometry>();
        EnumWindows(delegate (IntPtr window, IntPtr state)
        {
            try
            {
                if (window == IntPtr.Zero
                    || !IsWindowVisible(window)
                    || IsIconic(window)
                    || IsZoomed(window))
                    return true;

                uint processId;
                GetWindowThreadProcessId(window, out processId);
                if (processId == 0 || processId == (uint)ownProcessId)
                    return true;

                long extendedStyle = GetExtendedStyle(window);
                if ((extendedStyle & WS_EX_TOOLWINDOW) != 0
                    || (extendedStyle & WS_EX_TRANSPARENT) != 0)
                    return true;

                int cloaked;
                if (DwmGetWindowAttribute(
                    window,
                    DWMWA_CLOAKED,
                    out cloaked,
                    Marshal.SizeOf(typeof(int))
                ) == 0 && cloaked != 0)
                    return true;

                RECT bounds;
                if (DwmGetWindowAttribute(
                    window,
                    DWMWA_EXTENDED_FRAME_BOUNDS,
                    out bounds,
                    Marshal.SizeOf(typeof(RECT))
                ) != 0)
                    return true;

                int width = bounds.Right - bounds.Left;
                int height = bounds.Bottom - bounds.Top;
                if (width < MinimumWidth
                    || height < MinimumHeight
                    || IsFullscreen(window, bounds))
                    return true;

                results.Add(new Geometry
                {
                    hwnd = unchecked((ulong)window.ToInt64()).ToString(CultureInfo.InvariantCulture),
                    pid = processId,
                    left = bounds.Left,
                    top = bounds.Top,
                    right = bounds.Right,
                    bottom = bounds.Bottom
                });
                return results.Count < maximumPlatforms;
            }
            catch
            {
                // Windows can destroy a window between enumeration and bounds
                // lookup; that transient record is skipped without stopping.
                return true;
            }
        }, IntPtr.Zero);

        return results.ToArray();
    }
}
'@

try {
  # Add-Type is intentionally outside the loop: the process pays compilation
  # cost once and then emits compact JSONL snapshots at the requested cadence.
  Add-Type -TypeDefinition $source -Language CSharp
  $ownerProcess = [System.Diagnostics.Process]::GetProcessById($OwnProcessId)
  try {
    $ownerStartTimeUtcTicks = $ownerProcess.StartTime.ToUniversalTime().Ticks
  }
  finally {
    $ownerProcess.Dispose()
  }
  $cycle = [System.Diagnostics.Stopwatch]::new()
  $ownerProbeEveryCycles = [Math]::Max(1, [Math]::Ceiling(1000.0 / $IntervalMilliseconds))
  $cyclesUntilOwnerProbe = 0

  while ($true) {
    if ($cyclesUntilOwnerProbe -le 0) {
      $ownerProcess = $null
      try {
        $ownerProcess = [System.Diagnostics.Process]::GetProcessById($OwnProcessId)
        if ($ownerProcess.HasExited -or
            $ownerProcess.StartTime.ToUniversalTime().Ticks -ne $ownerStartTimeUtcTicks) { break }
      }
      catch {
        break
      }
      finally {
        if ($null -ne $ownerProcess) { $ownerProcess.Dispose() }
      }
      $cyclesUntilOwnerProbe = $ownerProbeEveryCycles
    }
    $cyclesUntilOwnerProbe -= 1

    $cycle.Restart()
    [object[]]$platforms = [WindowPlatformWatcher]::Scan($OwnProcessId, $MaximumPlatforms)
    $json = ConvertTo-Json -InputObject @($platforms) -Compress -Depth 3
    if ($null -eq $json) { $json = '[]' }
    if ($Utf8.GetByteCount($json) -gt $OutputLineByteLimit) {
      throw 'WINDOW_PLATFORM_LINE_TOO_LARGE'
    }

    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()

    $remaining = $IntervalMilliseconds - [int]$cycle.ElapsedMilliseconds
    if ($remaining -gt 0) {
      [System.Threading.Thread]::Sleep($remaining)
    }
  }
}
catch {
  # Only a fixed error code crosses stderr; no exception text, paths, titles,
  # or environment details are exposed to the parent process.
  [Console]::Error.WriteLine('WINDOW_PLATFORM_WATCHER_FAILED')
  exit 2
}
