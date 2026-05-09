param(
  [string]$CaptureRoot = (Join-Path (Join-Path $PSScriptRoot '..') '.tmp-tests'),
  [switch]$SkipTabDrag,
  [switch]$StrictTabDrag,
  [switch]$KeepRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class MiniTermWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@

$MouseLeftDown = 0x0002
$MouseLeftUp = 0x0004
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$CaptureRoot = [System.IO.Path]::GetFullPath($CaptureRoot)
$ArtifactDir = [System.IO.Path]::GetFullPath((Join-Path $CaptureRoot "desktop-ui-smoke-$Timestamp"))
$DataDir = [System.IO.Path]::GetFullPath((Join-Path $ArtifactDir 'data'))
$HomeDir = [System.IO.Path]::GetFullPath((Join-Path $ArtifactDir 'home'))
$WorkspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $ArtifactDir 'workspace'))
$StdoutLog = [System.IO.Path]::GetFullPath((Join-Path $ArtifactDir 'tauri-dev.out.log'))
$StderrLog = [System.IO.Path]::GetFullPath((Join-Path $ArtifactDir 'tauri-dev.err.log'))

New-Item -ItemType Directory -Force -Path $ArtifactDir, $DataDir, $HomeDir, $WorkspaceRoot | Out-Null

function Get-LogTail {
  param(
    [string]$Path,
    [int]$Lines = 30
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return ''
  }

  return (Get-Content -LiteralPath $Path -Tail $Lines) -join [Environment]::NewLine
}

function Write-SmokeConfigWithHelper {
  param(
    [string]$Root,
    [string]$DataPath,
    [string]$WorkspacePath
  )

  $args = @(
    'run',
    '--quiet',
    '--manifest-path',
    (Join-Path $Root 'src-tauri\Cargo.toml'),
    '--bin',
    'mini-term-desktop-smoke-config',
    '--',
    $DataPath,
    $WorkspacePath
  )

  $output = & cargo @args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to write canonical smoke config.`n$($output -join [Environment]::NewLine)"
  }
}

function New-SmokeWorkspace {
  param(
    [string]$WorkspacePath
  )

  New-Item -ItemType Directory -Force -Path (Join-Path $WorkspacePath 'src') | Out-Null
  'Mini-Term desktop UI smoke workspace' | Set-Content -LiteralPath (Join-Path $WorkspacePath 'README.md') -Encoding UTF8
  'export const smoke = true;' | Set-Content -LiteralPath (Join-Path $WorkspacePath 'src\index.ts') -Encoding UTF8
  'desktop smoke instructions' | Set-Content -LiteralPath (Join-Path $WorkspacePath 'AGENTS.md') -Encoding UTF8
}

function Start-TauriDevHarness {
  param(
    [string]$Root,
    [string]$DataPath,
    [string]$HomePath,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $command = @"
`$env:MINI_TERM_DATA_DIR = '$($DataPath -replace "'", "''")'
`$env:MINI_TERM_HOME_DIR = '$($HomePath -replace "'", "''")'
`$env:MINI_TERM_DISABLE_CONFIG_WRITES = '1'
Set-Location '$($Root -replace "'", "''")'
npm run tauri:dev
"@

  return Start-Process `
    -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command) `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -PassThru
}

function Get-DesktopAppProcess {
  param(
    [datetime]$StartedAfter
  )

  $candidates = Get-Process -Name 'tauri-app' -ErrorAction SilentlyContinue | Where-Object {
    try {
      return $_.StartTime -ge $StartedAfter
    } catch {
      return $false
    }
  }

  return $candidates | Sort-Object StartTime -Descending | Select-Object -First 1
}

function Wait-ForDesktopAppProcess {
  param(
    [datetime]$StartedAfter,
    [int]$TimeoutSeconds = 90
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $process = Get-DesktopAppProcess -StartedAfter $StartedAfter
    if ($process) {
      return $process
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Timed out waiting for target\debug\tauri-app.exe.`nSTDOUT:`n$(Get-LogTail -Path $StdoutLog)`nSTDERR:`n$(Get-LogTail -Path $StderrLog)"
}

function Get-WindowElement {
  param(
    [int]$ProcessId
  )

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  if (-not $windows) {
    return $null
  }

  $best = $null
  $bestArea = -1.0
  for ($index = 0; $index -lt $windows.Count; $index += 1) {
    $candidate = $windows.Item($index)
    $rect = $candidate.Current.BoundingRectangle
    $area = $rect.Width * $rect.Height
    if ($area -gt $bestArea) {
      $best = $candidate
      $bestArea = $area
    }
  }

  return $best
}

function Wait-ForWindowElement {
  param(
    [int]$ProcessId,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $window = Get-WindowElement -ProcessId $ProcessId
    if ($window) {
      return $window
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Timed out waiting for a desktop window for PID $ProcessId."
}

function Focus-Window {
  param(
    [System.Windows.Automation.AutomationElement]$Window
  )

  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  [MiniTermWin32]::ShowWindowAsync($handle, 9) | Out-Null
  Start-Sleep -Milliseconds 150
  [MiniTermWin32]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 350
}

function Save-WindowCapture {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$Path
  )

  $rect = $Window.Current.BoundingRectangle
  $width = [Math]::Max(1, [int]$rect.Width)
  $height = [Math]::Max(1, [int]$rect.Height)
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen([int]$rect.X, [int]$rect.Y, 0, 0, $bitmap.Size)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-Descendants {
  param(
    [System.Windows.Automation.AutomationElement]$Window
  )

  return $Window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
}

function Get-VisibleElements {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string[]]$Names,
    [System.Windows.Automation.ControlType]$ControlType,
    [scriptblock]$Filter
  )

  $nameList = @($Names)
  $result = @()
  $all = Get-Descendants -Window $Window
  if (-not $all) {
    return @()
  }

  $itemCount = 0
  try {
    $itemCount = $all.Count
  } catch {
    $itemCount = 0
  }

  for ($index = 0; $index -lt $itemCount; $index += 1) {
    $element = $all.Item($index)
    $current = $element.Current
    if ($ControlType -and $current.ControlType -ne $ControlType) {
      continue
    }
    if ($nameList.Count -gt 0 -and $nameList -notcontains $current.Name) {
      continue
    }
    if ($current.IsOffscreen) {
      continue
    }

    $bounds = $current.BoundingRectangle
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
      continue
    }

    if ($Filter -and -not (& $Filter $element)) {
      continue
    }

    $result += $element
  }
  return $result
}

function Get-TopTabLabels {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string[]]$CandidateNames
  )

  $labels = Get-VisibleElements `
    -Window $Window `
    -Names $CandidateNames `
    -ControlType ([System.Windows.Automation.ControlType]::Text) `
    -Filter {
      param($element)
      $bounds = $element.Current.BoundingRectangle
      return $bounds.Y -ge 60 -and $bounds.Y -le 110 -and $bounds.X -ge 700
    }

  return @(
    $labels |
      Sort-Object { $_.Current.BoundingRectangle.X } |
      ForEach-Object { $_.Current.Name }
  )
}

function Wait-ForTabOrder {
  param(
    [int]$ProcessId,
    [string[]]$ExpectedOrder,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $window = Get-WindowElement -ProcessId $ProcessId
    if ($window) {
      $currentOrder = @(Get-TopTabLabels -Window $window -CandidateNames $ExpectedOrder)
      if ($currentOrder.Count -eq $ExpectedOrder.Count -and ($currentOrder -join '|') -eq ($ExpectedOrder -join '|')) {
        return $window
      }
    }
    Start-Sleep -Milliseconds 250
  }

  throw "Timed out waiting for tab order [$($ExpectedOrder -join ', ')]."
}

function Get-TabGroupByLabel {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$Label
  )

  $labelElement = Get-VisibleElements `
    -Window $Window `
    -Names @($Label) `
    -ControlType ([System.Windows.Automation.ControlType]::Text) `
    -Filter {
      param($element)
      $bounds = $element.Current.BoundingRectangle
      return $bounds.Y -ge 60 -and $bounds.Y -le 110 -and $bounds.X -ge 700
    } |
    Sort-Object { $_.Current.BoundingRectangle.X } |
    Select-Object -First 1

  if (-not $labelElement) {
    throw "Could not find top-level tab label '$Label'."
  }

  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $parent = $walker.GetParent($labelElement)
  if (-not $parent) {
    throw "Could not resolve the tab container for '$Label'."
  }
  return $parent
}

function Click-Point {
  param(
    [int]$X,
    [int]$Y
  )

  [MiniTermWin32]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 120
  [MiniTermWin32]::mouse_event($MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [MiniTermWin32]::mouse_event($MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 450
}

function Click-TabByLabel {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$Label
  )

  $tab = Get-TabGroupByLabel -Window $Window -Label $Label
  $bounds = $tab.Current.BoundingRectangle
  $clickX = [int]($bounds.X + [Math]::Min(48, [Math]::Max(20, $bounds.Width / 3)))
  $clickY = [int]($bounds.Y + ($bounds.Height / 2))
  Click-Point -X $clickX -Y $clickY
}

function Get-VisibleButton {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string[]]$Names
  )

  return Get-VisibleElements `
    -Window $Window `
    -Names $Names `
    -ControlType ([System.Windows.Automation.ControlType]::Button) `
    -Filter {
      param($element)
      $bounds = $element.Current.BoundingRectangle
      return $bounds.Y -ge 100 -and $bounds.Y -le 180 -and $bounds.X -ge 700
    } |
    Sort-Object { $_.Current.BoundingRectangle.X } |
    Select-Object -First 1
}

function Invoke-VisibleButton {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string[]]$Names
  )

  $button = Get-VisibleButton -Window $Window -Names $Names
  if (-not $button) {
    throw "Could not find a visible button named [$($Names -join ', ')]."
  }

  $patternObject = $null
  if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$patternObject)) {
    $patternObject.Invoke()
  } else {
    $bounds = $button.Current.BoundingRectangle
    Click-Point -X ([int]($bounds.X + ($bounds.Width / 2))) -Y ([int]($bounds.Y + ($bounds.Height / 2)))
  }
  Start-Sleep -Milliseconds 900
}

function Get-MovePaneButtonCount {
  param(
    [System.Windows.Automation.AutomationElement]$Window
  )

  $buttons = Get-VisibleElements `
    -Window $Window `
    -Names @('Move Pane') `
    -ControlType ([System.Windows.Automation.ControlType]::Button) `
    -Filter {
      param($element)
      $bounds = $element.Current.BoundingRectangle
      return $bounds.Y -ge 100 -and $bounds.Y -le 180 -and $bounds.X -ge 700
    }

  return @($buttons).Count
}

function Invoke-TabDragReorder {
  param(
    [System.Windows.Automation.AutomationElement]$Window,
    [string]$SourceLabel,
    [string]$TargetLabel
  )

  $source = Get-TabGroupByLabel -Window $Window -Label $SourceLabel
  $target = Get-TabGroupByLabel -Window $Window -Label $TargetLabel
  $sourceBounds = $source.Current.BoundingRectangle
  $targetBounds = $target.Current.BoundingRectangle
  $startX = [int]($sourceBounds.X + [Math]::Min(40, [Math]::Max(16, $sourceBounds.Width / 3)))
  $startY = [int]($sourceBounds.Y + ($sourceBounds.Height / 2))
  $endX = [int]($targetBounds.X + $targetBounds.Width - 24)
  $endY = [int]($targetBounds.Y + ($targetBounds.Height / 2))

  [MiniTermWin32]::SetCursorPos($startX, $startY) | Out-Null
  Start-Sleep -Milliseconds 180
  [MiniTermWin32]::mouse_event($MouseLeftDown, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 160

  $steps = 14
  for ($step = 1; $step -le $steps; $step += 1) {
    $x = [int]($startX + (($endX - $startX) * $step / $steps))
    $y = [int]($startY + (($endY - $startY) * $step / $steps))
    [MiniTermWin32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 45
  }

  Start-Sleep -Milliseconds 220
  [MiniTermWin32]::mouse_event($MouseLeftUp, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 900
}

function Stop-LauncherProcessTree {
  param(
    [System.Diagnostics.Process]$Launcher
  )

  if ($Launcher -and -not $Launcher.HasExited) {
    & taskkill /pid $Launcher.Id /t /f | Out-Null
  }
}

New-SmokeWorkspace -WorkspacePath $WorkspaceRoot
Write-SmokeConfigWithHelper -Root $RepoRoot -DataPath $DataDir -WorkspacePath $WorkspaceRoot
$PrelaunchConfigPath = Join-Path $ArtifactDir 'prelaunch-config.json'
Copy-Item -LiteralPath (Join-Path $DataDir 'config.json') -Destination $PrelaunchConfigPath -Force
$prelaunchConfigText = Get-Content -LiteralPath $PrelaunchConfigPath -Raw
if ($prelaunchConfigText -notmatch '"workspace-1"' -or $prelaunchConfigText -notmatch '"workspaces"\s*:\s*\[') {
  throw "Smoke config helper did not write the expected workspace config."
}

$launcher = $null
$window = $null
$appProcess = $null
$dragPassed = $false
$dragAttempted = $false

try {
  $startedAt = Get-Date
  $launcher = Start-TauriDevHarness `
    -Root $RepoRoot `
    -DataPath $DataDir `
    -HomePath $HomeDir `
    -StdoutPath $StdoutLog `
    -StderrPath $StderrLog

  $appProcess = Wait-ForDesktopAppProcess -StartedAfter $startedAt
  $window = Wait-ForWindowElement -ProcessId $appProcess.Id
  Focus-Window -Window $window

  $window = Wait-ForTabOrder -ProcessId $appProcess.Id -ExpectedOrder @('Alpha', 'cmd')
  Save-WindowCapture -Window $window -Path (Join-Path $ArtifactDir '01-launch.png')

  Click-TabByLabel -Window $window -Label 'cmd'
  $window = Wait-ForWindowElement -ProcessId $appProcess.Id
  Save-WindowCapture -Window $window -Path (Join-Path $ArtifactDir '02-cmd-selected.png')

  Invoke-VisibleButton -Window $window -Names @('向右分屏', 'Split Right')
  $window = Wait-ForTabOrder -ProcessId $appProcess.Id -ExpectedOrder @('Alpha', 'Split View')
  $movePaneCount = Get-MovePaneButtonCount -Window $window
  if ($movePaneCount -lt 2) {
    throw "Split-right did not expose multiple pane drag handles. Visible Move Pane buttons: $movePaneCount."
  }
  Save-WindowCapture -Window $window -Path (Join-Path $ArtifactDir '03-after-split.png')

  if (-not $SkipTabDrag) {
    $dragAttempted = $true
    $tabOrderBeforeDrag = Get-TopTabLabels -Window $window -CandidateNames @('Alpha', 'Split View')
    if ((@($tabOrderBeforeDrag) -join '|') -ne 'Alpha|Split View') {
      throw "Unexpected tab order before drag: [$($tabOrderBeforeDrag -join ', ')]."
    }

    foreach ($attempt in 1..3) {
      Invoke-TabDragReorder -Window $window -SourceLabel 'Alpha' -TargetLabel 'Split View'
      $window = Wait-ForWindowElement -ProcessId $appProcess.Id
      $currentOrder = Get-TopTabLabels -Window $window -CandidateNames @('Alpha', 'Split View')
      Save-WindowCapture -Window $window -Path (Join-Path $ArtifactDir ("04-after-tab-drag-attempt-$attempt.png"))
      if ((@($currentOrder) -join '|') -eq 'Split View|Alpha') {
        $dragPassed = $true
        break
      }
    }

    if (-not $dragPassed -and $StrictTabDrag) {
      throw "Tab drag reorder never reached [Split View, Alpha]."
    }
  }

  $summary = @{
    ok = $true
    artifactDir = $ArtifactDir
    dataDir = $DataDir
    workspaceRoot = $WorkspaceRoot
    processId = $appProcess.Id
    initialTabOrder = @('Alpha', 'cmd')
    postSplitTabOrder = @('Alpha', 'Split View')
    movePaneCount = $movePaneCount
    tabDrag = @{
      attempted = $dragAttempted
      passed = $dragPassed
      strict = [bool]$StrictTabDrag
      skipped = [bool]$SkipTabDrag
    }
    logs = @{
      stdout = $StdoutLog
      stderr = $StderrLog
    }
  }

  $summary | ConvertTo-Json -Depth 8
} catch {
  if ($window) {
    try {
      Save-WindowCapture -Window $window -Path (Join-Path $ArtifactDir 'failure.png')
    } catch {}
  }

  Write-Error (
    @(
      $_.Exception.Message
      ''
      "Artifacts: $ArtifactDir"
      ''
      'STDOUT tail:'
      (Get-LogTail -Path $StdoutLog)
      ''
      'STDERR tail:'
      (Get-LogTail -Path $StderrLog)
    ) -join [Environment]::NewLine
  )
  exit 1
} finally {
  if (-not $KeepRunning) {
    Stop-LauncherProcessTree -Launcher $launcher
  }
}
