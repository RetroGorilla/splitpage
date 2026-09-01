<#
  Splitpage driver - serves the app on http://localhost:<Port>/ and drives
  headless Edge over the Chrome DevTools Protocol.

  Reads one command per line from stdin, so it works both as a script
  (heredoc / pipe) and interactively. See SKILL.md for the command list.

  There is no Node and no Python on this machine: the whole harness is
  Windows PowerShell 5.1 + .NET (HttpListener, ClientWebSocket) + msedge.exe.
#>
[CmdletBinding()]
param(
  [int]$Port = 8791,
  [int]$CdpPort = 9333,
  [string]$Root,
  [string]$ShotDir,
  [switch]$Headed,
  # Read commands from a file instead of stdin. Prefer this: piping into
  # [Console]::In from another PowerShell is fragile — the parent can sit on a
  # buffered pipeline long after the driver has finished and exited.
  [string]$Script
)

$ErrorActionPreference = 'Stop'
if (-not $Root)    { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
if (-not $ShotDir) { $ShotDir = Join-Path $env:TEMP 'splitpage-shots' }
New-Item -ItemType Directory -Force -Path $ShotDir | Out-Null

function Log($m)  { [Console]::Error.WriteLine("[driver] $m") }
function Out1($m) { [Console]::Out.WriteLine($m) }

# ---------------------------------------------------------------- static server
# Own HttpListener rather than start.ps1: start.ps1 also does Start-Process on
# the URL, which pops a real Edge window on the user's desktop.
$script:ServerPs = $null
function Start-Server {
  if ($script:ServerPs) { return }
  $sb = {
    param($root, $port)
    $mime = @{
      '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
      '.json' = 'application/json; charset=utf-8'; '.webmanifest' = 'application/manifest+json; charset=utf-8'
      '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'
      '.css' = 'text/css; charset=utf-8'
    }
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$port/")
    $l.Start()
    while ($l.IsListening) {
      $ctx = $l.GetContext()
      $res = $ctx.Response
      try {
        $p = $ctx.Request.Url.AbsolutePath
        if ($p -eq '/') { $p = '/index.html' }
        $f = [System.IO.Path]::GetFullPath((Join-Path $root $p.TrimStart('/')))
        if (-not $f.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
          $res.StatusCode = 403
        } elseif (-not (Test-Path $f -PathType Leaf)) {
          $res.StatusCode = 404
        } else {
          $ext = [System.IO.Path]::GetExtension($f).ToLower()
          $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
          $b = [System.IO.File]::ReadAllBytes($f)
          $res.ContentLength64 = $b.Length
          $res.OutputStream.Write($b, 0, $b.Length)
        }
      } catch { $res.StatusCode = 500 } finally { $res.OutputStream.Close() }
    }
  }
  $script:ServerPs = [PowerShell]::Create()
  $null = $script:ServerPs.AddScript($sb).AddArgument($Root).AddArgument($Port)
  $null = $script:ServerPs.BeginInvoke()
  for ($i = 0; $i -lt 40; $i++) {
    try { $null = Invoke-WebRequest "http://localhost:$Port/index.html" -UseBasicParsing -TimeoutSec 2
          Log "server up on http://localhost:$Port/ (root $Root)"; return } catch { Start-Sleep -Milliseconds 250 }
  }
  throw "static server did not come up on port $Port (port already in use?)"
}

# ------------------------------------------------------------------------ edge
$script:EdgeProc = $null
$script:UserDataDir = $null
function Find-Edge {
  $c = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
  throw 'msedge.exe not found'
}
function Start-Edge {
  if ($script:EdgeProc) { return }
  $exe = Find-Edge
  $script:UserDataDir = Join-Path $env:TEMP ("splitpage-edge-" + [guid]::NewGuid().ToString('N').Substring(0,8))
  $a = @(
    "--remote-debugging-port=$CdpPort",
    "--user-data-dir=$script:UserDataDir",
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-features=Translate,msEdgeSplitScreen,msImplicitSignin',
    '--window-size=1440,960',
    'about:blank'
  )
  if (-not $Headed) { $a = @('--headless=new') + $a }
  $script:EdgeProc = Start-Process -FilePath $exe -ArgumentList $a -PassThru -WindowStyle Hidden
  Log "edge pid=$($script:EdgeProc.Id) cdp=$CdpPort headless=$(-not $Headed)"
}

# ------------------------------------------------------------------------- cdp
$script:Ws = $null
$script:MsgId = 0
$script:Console = New-Object System.Collections.ArrayList

function Connect-Cdp {
  if ($script:Ws) { return }
  $wsUrl = $null
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $list = Invoke-RestMethod "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 2
      $page = @($list | Where-Object { $_.type -eq 'page' })[0]
      if ($page) { $wsUrl = $page.webSocketDebuggerUrl; break }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  if (-not $wsUrl) { throw "no CDP page target on port $CdpPort" }
  $script:Ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:Ws.ConnectAsync([uri]$wsUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  Log 'cdp connected'
  $null = Send-Cdp 'Page.enable'
  $null = Send-Cdp 'Runtime.enable'
  $null = Send-Cdp 'Log.enable'
}

function Receive-Raw([int]$TimeoutMs = 30000) {
  $buf = New-Object byte[] 262144
  $seg = [ArraySegment[byte]]::new($buf, 0, $buf.Length)
  $ms  = New-Object System.IO.MemoryStream
  $cts = New-Object Threading.CancellationTokenSource
  $cts.CancelAfter($TimeoutMs)
  do {
    $r = $script:Ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()
    $ms.Write($buf, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  [Text.Encoding]::UTF8.GetString($ms.ToArray())
}

function Send-Cdp([string]$Method, [hashtable]$Params = @{}, [int]$TimeoutMs = 30000) {
  $script:MsgId++
  $id = $script:MsgId
  $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $script:Ws.SendAsync([ArraySegment[byte]]::new($bytes, 0, $bytes.Length),
    [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
    [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  while ($true) {
    $txt = Receive-Raw $TimeoutMs
    $msg = $txt | ConvertFrom-Json
    if (($msg.PSObject.Properties.Name -contains 'id') -and ($msg.id -eq $id)) {
      if ($msg.PSObject.Properties.Name -contains 'error') { throw "CDP $Method : $($msg.error.message)" }
      return $msg.result
    }
    if ($msg.method -eq 'Runtime.consoleAPICalled') {
      $a = ($msg.params.args | ForEach-Object { if ($null -ne $_.value) { "$($_.value)" } else { $_.description } }) -join ' '
      $null = $script:Console.Add("$($msg.params.type): $a")
    } elseif ($msg.method -eq 'Runtime.exceptionThrown') {
      $null = $script:Console.Add("exception: $($msg.params.exceptionDetails.exception.description)")
    } elseif ($msg.method -eq 'Log.entryAdded') {
      $null = $script:Console.Add("$($msg.params.entry.level): $($msg.params.entry.text)")
    }
  }
}

function Invoke-Js([string]$Expr, [int]$TimeoutMs = 30000) {
  $r = Send-Cdp 'Runtime.evaluate' @{
    expression = $Expr; returnByValue = $true; awaitPromise = $true; userGesture = $true
  } $TimeoutMs
  if ($r.exceptionDetails) {
    $d = $r.exceptionDetails.exception.description
    if (-not $d) { $d = $r.exceptionDetails.text }
    throw "JS error: $d"
  }
  $r.result.value
}

function Format-Val($v) {
  if ($null -eq $v) { return 'null' }
  if ($v -is [string]) { return $v }
  if ($v -is [bool] -or $v -is [int] -or $v -is [double] -or $v -is [long]) { return "$v" }
  return ($v | ConvertTo-Json -Depth 8 -Compress)
}

# ------------------------------------------------------------------ assertions
# Every assertion counts, so a run reports "N/M checks passed" instead of
# leaving you to read a wall of output and decide for yourself.
$script:Checks = 0
$script:Failures = 0

# expect <js>            — truthy, right now, no waiting
# expect <js> == <value> — compare against a literal (string, number, bool)
# Splitting on the LAST '==' so the expression may contain '===' freely.
function Expect-That([string]$Rest) {
  $script:Checks++
  $expr = $Rest; $want = $null; $hasWant = $false
  $i = $Rest.LastIndexOf('==')
  # only treat it as a comparison if the '==' isn't part of '===' or '!=='
  if ($i -gt 0 -and $Rest[$i - 1] -ne '=' -and $Rest[$i - 1] -ne '!' -and $Rest[$i - 1] -ne '<' -and $Rest[$i - 1] -ne '>') {
    $expr = $Rest.Substring(0, $i).Trim()
    $want = $Rest.Substring($i + 2).Trim()
    $hasWant = $true
  }
  $got = Invoke-Js $expr
  if ($hasWant) {
    $g = Format-Val $got
    if ($g -eq $want) { Out1 "PASS $expr == $want"; return }
    $script:Failures++
    Out1 "FAIL $expr"
    Out1 "     expected: $want"
    Out1 "     actual:   $g"
    return
  }
  if ($got) { Out1 "PASS $expr"; return }
  $script:Failures++
  Out1 "FAIL $expr  (got $(Format-Val $got))"
}

# --------------------------------------------------------------------- actions
function Wait-For([string]$Expr, [int]$TimeoutMs = 15000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    try { if (Invoke-Js "!!($Expr)") { return $true } } catch { }
    Start-Sleep -Milliseconds 200
  }
  throw "timed out after ${TimeoutMs}ms waiting for: $Expr"
}

function Go([string]$Target) {
  $url = if ($Target -match '^https?://') { $Target }
         elseif ($Target -match '^/')     { "http://localhost:$Port$Target" }
         else                             { "http://localhost:$Port/$Target" }
  $null = Send-Cdp 'Page.navigate' @{ url = $url }
  Wait-For 'document.readyState === "complete"' 30000 | Out-Null
  Out1 "at $url"
}

# A CSS selector, or one of:
#   text=Some Label   smallest visible element whose trimmed innerText EQUALS it
#   text*=Some Label  ... whose innerText CONTAINS it
# Prefer text*= for Splitpage's header buttons: PRODUCTION and COMMENTS grow a
# count badge inside them ("PRODUCTION2"), so exact matching stops working the
# moment the document has any tags or comments.
function Resolve-Sel([string]$Sel) {
  $ROLES = 'button,a,[role=button],[role=menuitem],[role=tab],label,summary,li,div,span'
  if ($Sel -match '^text(\*?)=(.*)$') {
    $contains = ($Matches[1] -eq '*')
    $t = $Matches[2].Replace('\', '\\').Replace('"', '\"')
    $test = if ($contains) { "t.indexOf(`"$t`") !== -1" } else { "t === `"$t`"" }
    return "(Array.from(document.querySelectorAll('$ROLES')).filter(e=>{if(e.offsetParent===null)return false;const t=(e.innerText||'').trim();return $test;}).sort((a,b)=>a.getElementsByTagName('*').length-b.getElementsByTagName('*').length)[0])"
  }
  $s = $Sel.Replace('\', '\\').Replace("'", "\'")
  return "document.querySelector('$s')"
}

function Click-El([string]$Sel) {
  $e = Resolve-Sel $Sel
  $box = Invoke-Js @"
(() => { const el = $e; if (!el) return null;
  el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height}; })()
"@
  if (-not $box) { throw "no element for: $Sel" }
  if ($box.w -le 0 -or $box.h -le 0) { throw "element has zero size: $Sel" }
  foreach ($t in @('mousePressed','mouseReleased')) {
    $null = Send-Cdp 'Input.dispatchMouseEvent' @{
      type = $t; x = [int]$box.x; y = [int]$box.y; button = 'left'; clickCount = 1
    }
  }
  Out1 "clicked $Sel at $([int]$box.x),$([int]$box.y)"
}

function Focus-El([string]$Sel) {
  $e = Resolve-Sel $Sel
  $ok = Invoke-Js "(() => { const el = $e; if (!el) return false; el.focus(); return document.activeElement === el || el.contains(document.activeElement); })()"
  if (-not $ok) { throw "could not focus: $Sel" }
  Out1 "focused $Sel"
}

# Focus a contenteditable AND drop the caret in it. Plain .focus() leaves the
# selection collapsed at offset 0 (or nowhere at all), so typed characters land
# at the top of the cell or are swallowed entirely.
function Set-Caret([string]$Sel, [string]$Where = 'end') {
  $e = Resolve-Sel $Sel
  $collapse = if ($Where -eq 'start') { 'true' } else { 'false' }
  $n = Invoke-Js @"
(() => { const el = $e; if (!el) return null;
  el.scrollIntoView({block:'center'}); el.focus();
  const r = document.createRange(); r.selectNodeContents(el); r.collapse($collapse);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return (el.innerText || '').length; })()
"@
  if ($null -eq $n) { throw "no element for: $Sel" }
  Out1 "caret $Where of $Sel (len $n)"
}

function Type-Text([string]$Text) {
  $null = Send-Cdp 'Input.insertText' @{ text = $Text }
  Out1 "typed $($Text.Length) chars"
}

# Per-character key events. Handlers that watch keydown - Splitpage's [ ] { }
# ~ ~ tag shortcuts do - never fire for Input.insertText.
function Press-Chars([string]$Text) {
  foreach ($ch in $Text.ToCharArray()) {
    $s = [string]$ch
    $null = Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyDown'; text = $s; unmodifiedText = $s; key = $s }
    $null = Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $s }
  }
  Out1 "pressed $($Text.Length) chars"
}

$KeyMap = @{
  Enter     = @{ key = 'Enter';     code = 'Enter';     vk = 13; text = "`r" }
  Tab       = @{ key = 'Tab';       code = 'Tab';       vk = 9;  text = "`t" }
  Escape    = @{ key = 'Escape';    code = 'Escape';    vk = 27 }
  Backspace = @{ key = 'Backspace'; code = 'Backspace'; vk = 8 }
  ArrowDown = @{ key = 'ArrowDown'; code = 'ArrowDown'; vk = 40 }
  ArrowUp   = @{ key = 'ArrowUp';   code = 'ArrowUp';   vk = 38 }
  Delete    = @{ key = 'Delete';    code = 'Delete';    vk = 46 }
  Home      = @{ key = 'Home';      code = 'Home';      vk = 36 }
  End       = @{ key = 'End';       code = 'End';       vk = 35 }
  KeyZ      = @{ key = 'z';         code = 'KeyZ';      vk = 90 }
  KeyF      = @{ key = 'f';         code = 'KeyF';      vk = 70 }
  # the rich-text shortcuts, which are otherwise only reachable by calling
  # execCommand directly - which tests the browser, not Splitpage's handler
  KeyA      = @{ key = 'a';         code = 'KeyA';      vk = 65 }
  KeyB      = @{ key = 'b';         code = 'KeyB';      vk = 66 }
  KeyI      = @{ key = 'i';         code = 'KeyI';      vk = 73 }
  KeyU      = @{ key = 'u';         code = 'KeyU';      vk = 85 }
}
function Press-Key([string]$Name, [string]$Mods = '') {
  if (-not $KeyMap.ContainsKey($Name)) { throw "unknown key '$Name' (have: $($KeyMap.Keys -join ', '))" }
  $k = $KeyMap[$Name]
  $m = 0
  if ($Mods -match 'ctrl')  { $m = $m -bor 2 }
  if ($Mods -match 'shift') { $m = $m -bor 8 }
  if ($Mods -match 'alt')   { $m = $m -bor 1 }
  $down = @{ type = 'keyDown'; key = $k.key; code = $k.code; windowsVirtualKeyCode = $k.vk; nativeVirtualKeyCode = $k.vk; modifiers = $m }
  if ($k.text -and $m -eq 0) { $down['text'] = $k.text }
  $null = Send-Cdp 'Input.dispatchKeyEvent' $down
  $null = Send-Cdp 'Input.dispatchKeyEvent' @{ type = 'keyUp'; key = $k.key; code = $k.code; windowsVirtualKeyCode = $k.vk; nativeVirtualKeyCode = $k.vk; modifiers = $m }
  Out1 "key $Mods $Name"
}

# viewport 375 812 mobile   — width height [mobile]
# viewport reset
# "mobile" also sets touch points and a mobile UA, which is what flips
# Splitpage's (hover: none) rules and its IS_TOUCH gestures.
function Set-Viewport([string]$Rest) {
  if ($Rest -match '^\s*reset\s*$') {
    $null = Send-Cdp 'Emulation.clearDeviceMetricsOverride'
    $null = Send-Cdp 'Emulation.setTouchEmulationEnabled' @{ enabled = $false }
    Out1 'viewport reset'
    return
  }
  $p = $Rest -split '\s+'
  if ($p.Count -lt 2) { throw 'viewport needs: <width> <height> [mobile]' }
  $w = [int]$p[0]; $h = [int]$p[1]
  $mobile = ($p.Count -ge 3 -and $p[2] -match 'mobile')
  $null = Send-Cdp 'Emulation.setDeviceMetricsOverride' @{
    width = $w; height = $h; deviceScaleFactor = 1; mobile = $mobile
  }
  # maxTouchPoints must be 1..16 even when disabling: CDP validates the field
  # before it looks at `enabled`, so passing 0 threw on every non-mobile
  # `viewport <w> <h>` and counted as a failing check.
  $null = Send-Cdp 'Emulation.setTouchEmulationEnabled' @{ enabled = $mobile; maxTouchPoints = $(if ($mobile) { 5 } else { 1 }) }
  Out1 "viewport ${w}x${h}$(if ($mobile) { ' mobile' })"
}

function Shot([string]$Name = 'shot') {
  $r = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false } 60000
  $path = Join-Path $ShotDir "$Name.png"
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($r.data))
  Out1 "shot $path"
}

# ---------------------------------------------------------------------- runner
function Invoke-Line([string]$line) {
  $line = $line.Trim()
  if (-not $line -or $line.StartsWith('#')) { return $true }
  # Split on the FIRST space only - splitting on \s+ would eat a leading space
  # in the argument, and "press  [gaffer tape]" needs that space to survive.
  $i = $line.IndexOf(' ')
  if ($i -lt 0) { $cmd = $line; $rest = '' } else { $cmd = $line.Substring(0, $i); $rest = $line.Substring($i + 1) }
  switch ($cmd.ToLower()) {
    'open'    { Start-Server; Start-Edge; Connect-Cdp; Go $(if ($rest) { $rest } else { '/index.html' }) }
    'goto'    { Go $rest }
    'eval'    { Out1 (Format-Val (Invoke-Js $rest)) }
    'expect'  { Expect-That $rest }
    'wait'    { $script:Checks++
                try { Wait-For $rest 20000 | Out-Null; Out1 "PASS (waited) $rest" }
                catch { $script:Failures++; Out1 "FAIL (timeout) $rest"; }
              }
    'waitsel' { Wait-For "document.querySelector('$rest')" 20000 | Out-Null; Out1 "ok: $rest" }
    'click'   { Click-El $rest }
    'jsclick' { $e = Resolve-Sel $rest
                $ok = Invoke-Js "(()=>{const el=$e; if(!el) return false; el.click(); return true;})()"
                if (-not $ok) { throw "no element for: $rest" }; Out1 "jsclicked $rest" }
    'focus'   { Focus-El $rest }
                # selectors may contain spaces, so only a trailing " start" is an arg
    'caret'   { if ($rest -match '^(.*)\s+start$') { Set-Caret $Matches[1] 'start' } else { Set-Caret $rest 'end' } }
    'type'    { Type-Text $rest }
    'press'   { Press-Chars $rest }
    'key'     { $p = $rest -split '\s+'
                if ($p.Count -ge 2) { Press-Key $p[1] $p[0].ToLower() } else { Press-Key $p[0] } }
    'text'    { $e = Resolve-Sel $rest
                Out1 (Format-Val (Invoke-Js "(()=>{const el=$e; return el ? el.innerText : null;})()")) }
    'count'   { Out1 (Format-Val (Invoke-Js "document.querySelectorAll('$rest').length")) }
    'sel'     { Out1 (Resolve-Sel $rest) }
    'viewport' { Set-Viewport $rest }
    'shot'    { Shot $(if ($rest) { $rest } else { 'shot' }) }
    'logs'    { if ($script:Console.Count -eq 0) { Out1 '(no console output)' } else { $script:Console | ForEach-Object { Out1 $_ } } }
    'sleep'   { Start-Sleep -Milliseconds ([int]$rest) }
    'quit'    { return $false }
    default   { throw "unknown command: $cmd" }
  }
  return $true
}

$exit = 0
try {
  if ($Script) {
    if (-not (Test-Path $Script)) { throw "script not found: $Script" }
    # Read as UTF-8 explicitly. Get-Content on 5.1 decodes a BOM-less file with
    # the system ANSI codepage, so a bullet or an em dash in an assertion
    # arrives as mojibake and the comparison fails against an app that is
    # perfectly fine. That has cost time twice.
    $scriptText = [System.Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Script)))
    foreach ($line in ($scriptText -split "`r?`n")) {
      try { if (-not (Invoke-Line $line)) { break } }
      catch { Out1 "ERROR: $($_.Exception.Message)"; $script:Failures++; $exit = 1 }
    }
  } else {
    while ($true) {
      $line = [Console]::In.ReadLine()
      if ($null -eq $line) { break }
      try { if (-not (Invoke-Line $line)) { break } }
      catch { Out1 "ERROR: $($_.Exception.Message)"; $script:Failures++; $exit = 1 }
    }
  }
  # A run that asserted nothing is a run that proved nothing.
  if ($script:Checks -eq 0 -and $script:Failures -eq 0) {
    Out1 'WARNING: no expect/wait assertions ran - this proved nothing.'
  }
  # Built in pieces on purpose: PS 5.1 cannot parse a double-quoted string
  # inside a $() subexpression inside another double-quoted string. Kept
  # ASCII-only too, since this file is read without a BOM.
  $passed = $script:Checks - $script:Failures
  $summary = "RESULT: $passed/$($script:Checks) checks passed"
  if ($script:Failures -gt 0) { $summary = $summary + " - $($script:Failures) FAILED" }
  Out1 ''
  Out1 $summary
} finally {
  if ($script:Ws) { try { $script:Ws.Dispose() } catch {} }
  if ($script:EdgeProc) { try { Stop-Process -Id $script:EdgeProc.Id -Force -ErrorAction SilentlyContinue } catch {} }
  # Start-Process hands back Edge's launcher, which spawns the browser tree and
  # exits — killing it alone leaves the actual browser running. Sweep by this
  # run's own profile directory, so nothing but our own processes can match.
  if ($script:UserDataDir) {
    try {
      $dir = Split-Path -Leaf $script:UserDataDir
      Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch {}
  }
  if ($script:UserDataDir -and (Test-Path $script:UserDataDir)) {
    Start-Sleep -Milliseconds 300
    Remove-Item -Recurse -Force $script:UserDataDir -ErrorAction SilentlyContinue
  }
  Log "done (exit $exit)"
}
exit $exit
