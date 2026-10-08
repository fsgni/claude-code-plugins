# role-board in a Windows Terminal pane: the board of a folder's
# conversations, beside the conversation whose /board opened it.
#
# The plugin writes the screen (every line, already in words and tones);
# this script fits it to the pane and redraws it when it changes. q, Esc or
# Ctrl+C closes the pane, and so does the conversation ending.
#
# Kept to ASCII: Windows PowerShell reads a script without a byte order
# mark in the system code page, so every other character comes from the
# screen or from a [char] code.
param(
  # The screen file the plugin writes.
  [Parameter(Mandatory = $true)][string]$Screen,
  # Draws one frame as plain lines and exits: for trying the script out.
  [switch]$Once,
  [int]$Width = 40,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8

$esc = [char]27
$reset = "$esc[0m"
# The terminal's own palette, so the pane takes its color scheme; Claude's
# orange is the 256-color one nearest it.
$tones = @{
  claude  = "$esc[38;5;173m"
  warning = "$esc[33m"
  success = "$esc[32m"
  muted   = "$esc[90m"
  accent  = "$esc[94m"
  strong  = "$esc[1m"
}
$ellipsis = [string][char]0x2026
# How long the screen may go unwritten before the pane says its
# conversation stopped answering.
$staleMs = 30000

# Cells a character takes: two for the wide ones (CJK, full-width forms,
# emoji), one for the rest, Nerd Font icons included.
function Get-Cells([int]$code) {
  if (($code -ge 0x1100 -and $code -le 0x115F) -or
      ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
      ($code -ge 0xAC00 -and $code -le 0xD7A3) -or
      ($code -ge 0xF900 -and $code -le 0xFAFF) -or
      ($code -ge 0xFE30 -and $code -le 0xFE4F) -or
      ($code -ge 0xFF00 -and $code -le 0xFF60) -or
      ($code -ge 0xFFE0 -and $code -le 0xFFE6) -or
      ($code -ge 0x1F300 -and $code -le 0x1FAFF) -or
      ($code -ge 0x20000 -and $code -le 0x3FFFD)) {
    return 2
  }

  return 1
}

# A text's characters, a surrogate pair as one, each with its cells.
function Split-Text([string]$text) {
  $parts = New-Object System.Collections.Generic.List[object]
  $i = 0

  while ($i -lt $text.Length) {
    if ([char]::IsHighSurrogate($text[$i]) -and $i + 1 -lt $text.Length) {
      $code = [char]::ConvertToUtf32($text[$i], $text[$i + 1])
      $parts.Add(@($text.Substring($i, 2), (Get-Cells $code)))
      $i += 2
    } else {
      $parts.Add(@([string]$text[$i], (Get-Cells ([int]$text[$i]))))
      $i += 1
    }
  }

  return , $parts
}

function Measure-Spans($spans) {
  $cells = 0

  foreach ($span in $spans) {
    foreach ($part in (Split-Text ([string]$span.text))) {
      $cells += $part[1]
    }
  }

  return $cells
}

# The spans in their tones, cut to `room` cells with an ellipsis.
function Format-Spans($spans, [int]$room) {
  $out = New-Object System.Text.StringBuilder
  $isCut = (Measure-Spans $spans) -gt $room
  $limit = if ($isCut) { $room - 1 } else { $room }
  $used = 0

  foreach ($span in $spans) {
    $tone = $tones[[string]$span.tone]

    if ($tone) {
      [void]$out.Append($tone)
    }

    foreach ($part in (Split-Text ([string]$span.text))) {
      if ($used + $part[1] -gt $limit) {
        break
      }

      [void]$out.Append($part[0])
      $used += $part[1]
    }

    if ($tone) {
      [void]$out.Append($reset)
    }

    if ($used -ge $limit) {
      break
    }
  }

  if ($isCut -and $room -ge 1) {
    [void]$out.Append($tones.muted + $ellipsis + $reset)
    $used += 1
  }

  return @{ text = $out.ToString(); cells = $used }
}

# One line `width` cells wide: its left part, and its right part flush right.
function Format-Line($line, [int]$width) {
  $rightCells = 0
  $rightText = ''

  if ($line.right) {
    $right = Format-Spans $line.right $width
    $rightCells = $right.cells
    $rightText = $right.text
  }

  $gap = if ($rightCells -gt 0) { 1 } else { 0 }
  $left = Format-Spans $line.left ([Math]::Max(0, $width - $rightCells - $gap))
  $pad = [Math]::Max(0, $width - $left.cells - $rightCells)

  return $left.text + (' ' * $pad) + $rightText
}

# The pane's rows: the screen's lines from the top, its hint (or why it
# went quiet) on the bottom row.
function Format-Rows($screen, [int]$width, [int]$height, [bool]$isStale) {
  $rows = New-Object System.Collections.Generic.List[string]

  foreach ($line in $screen.lines) {
    $rows.Add((Format-Line $line $width))
  }

  $footer = if ($isStale) {
    Format-Line @{ left = @(@{ text = [string]$screen.staleNote; tone = 'warning' }) } $width
  } else {
    Format-Line @{ left = @(@{ text = [string]$screen.hint; tone = 'muted' }) } $width
  }

  if ($height -le 0) {
    $rows.Add('')
    $rows.Add($footer)

    return , $rows
  }

  while ($rows.Count -gt $height - 1) {
    $rows.RemoveAt($rows.Count - 1)
  }

  while ($rows.Count -lt $height - 1) {
    $rows.Add('')
  }

  $rows.Add($footer)

  return , $rows
}

function Read-Screen {
  return [IO.File]::ReadAllText($Screen, $utf8) | ConvertFrom-Json
}

function Get-Now {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

if ($Once) {
  $shown = Read-Screen

  foreach ($row in (Format-Rows $shown $Width $Height $false)) {
    [Console]::WriteLine($row)
  }

  exit 0
}

# The console draws escape sequences only once asked to.
Add-Type -Namespace RoleBoard -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int handle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr handle, uint mode);
'@
$handle = [RoleBoard.Native]::GetStdHandle(-11)
$mode = [uint32]0

if ([RoleBoard.Native]::GetConsoleMode($handle, [ref]$mode)) {
  [void][RoleBoard.Native]::SetConsoleMode($handle, $mode -bor 4)
}

# The pane's title while it has the focus.
$Host.UI.RawUI.WindowTitle = [string][char]0x804C + [char]0x8D23
[Console]::TreatControlCAsInput = $true
[Console]::Write("$esc[?25l$esc[2J")

$shown = $null
$stamp = [DateTime]::MinValue
$drawn = ''
$size = ''
$isRunning = $true

try {
  while ($isRunning) {
    while ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      $isCtrlC = $key.Key -eq 'C' -and ($key.Modifiers -band [ConsoleModifiers]::Control)

      if ($key.Key -eq 'Q' -or $key.Key -eq 'Escape' -or $isCtrlC) {
        $isRunning = $false
      }
    }

    # A screen half written, or not there yet, leaves the last one drawn.
    try {
      $written = [IO.File]::GetLastWriteTimeUtc($Screen)

      if ($written -ne $stamp) {
        $shown = Read-Screen
        $stamp = $written
      }
    } catch {
    }

    if ($shown -and $shown.ended) {
      $isRunning = $false
    }

    if (-not $isRunning) {
      break
    }

    $width = [Console]::WindowWidth - 1
    $height = [Console]::WindowHeight
    $now = "$width x $height"

    if ($now -ne $size) {
      [Console]::Write("$esc[2J")
      $size = $now
      $drawn = ''
    }

    if ($shown) {
      $isStale = ((Get-Now) - [double]$shown.at) -gt $staleMs
      $rows = Format-Rows $shown $width $height $isStale
      $frame = New-Object System.Text.StringBuilder

      for ($i = 0; $i -lt $rows.Count; $i += 1) {
        [void]$frame.Append("$esc[$($i + 1);1H" + $rows[$i] + "$reset$esc[K")
      }

      $text = $frame.ToString()

      if ($text -ne $drawn) {
        [Console]::Write($text)
        $drawn = $text
      }
    }

    Start-Sleep -Milliseconds 400
  }
} finally {
  [Console]::Write("$reset$esc[?25h")
}

exit 0
