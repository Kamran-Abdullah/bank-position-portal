<#
  Bank Position - Outlook agent
  Reads the Outlook mailbox set in config.json (READ-ONLY: it never moves, deletes or marks mail),
  finds bank-statement e-mails, and saves their attachments into the portal's "Inbox Drop" folder.
  The portal picks the files up, works out which bank account each belongs to and posts the balances.

  Safe to run as often as you like: every e-mail already handled is remembered in state.json.
  If the PC / portal was off, the next run simply catches up on everything that arrived meanwhile.

  Usage:  powershell -File Fetch-BankStatements.ps1            (normal run)
          powershell -File Fetch-BankStatements.ps1 -DryRun    (only list what it WOULD save / send)
          powershell -File Fetch-BankStatements.ps1 -NoSend    (builds the notification in Outlook, then discards it)
#>
param([switch]$DryRun, [switch]$NoSend, [int]$LookbackDays = 0, [string]$InboxDrop = '', [string]$StateFile = '', [switch]$PortalOnly, [switch]$Loop, [int]$EveryMinutes = 10, [int]$PortalPort = 4201)

$ErrorActionPreference = 'Stop'

# ---- -Loop: stay alive in the background and run a check every N minutes (used from the Startup folder, no Task Scheduler needed) ----
if ($Loop) {
  $created = $false
  $mutex = New-Object System.Threading.Mutex($true, 'Global\BankPositionAgentLoop', [ref]$created)
  if (-not $created) { exit 0 }               # a loop is already running
  while ($true) {
    try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $MyInvocation.MyCommand.Path + '"')) -WindowStyle Hidden -Wait } catch {}
    Start-Sleep -Seconds ($EveryMinutes * 60)
  }
}

$listOnly = ($DryRun -or $NoSend)     # -NoSend also leaves the mailbox, folder and state completely untouched
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg  = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$drop = if ($InboxDrop) { $InboxDrop } elseif ($cfg.inboxDrop) { $cfg.inboxDrop } else { '..\Inbox Drop' }
if (-not [IO.Path]::IsPathRooted($drop)) { $drop = [IO.Path]::GetFullPath((Join-Path $here $drop)) }
$statePath = if ($StateFile) { $StateFile } else { Join-Path $here 'state.json' }
$logPath   = Join-Path $here 'agent.log'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Log([string]$m) {
  $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}
function Trim-Log { if ((Test-Path $logPath) -and ((Get-Item $logPath).Length -gt 1MB)) { $t = Get-Content $logPath -Tail 2000; Set-Content $logPath $t -Encoding UTF8 } }

# ---- keep the portal running by itself: start it hidden if it is not up, so nobody has to launch or log in ----
$root = [IO.Path]::GetFullPath((Join-Path $here '..'))
function Test-Portal { try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$PortalPort/api/health" -TimeoutSec 3 -ErrorAction Stop; return [bool]$r.ok } catch { return $false } }
function Ensure-Portal {
  if (Test-Portal) { return $true }
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $node) { foreach ($c in 'C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe', "$env:LOCALAPPDATA\Programs\nodejs\node.exe") { if (Test-Path $c) { $node = $c; break } } }
  if (-not $node -or -not (Test-Path (Join-Path $root 'server.js'))) { Log 'portal is down and cannot be started (Node.js or server.js not found)'; return $false }
  Log 'portal is not running - starting it in the background'
  $env:PORT = [string]$PortalPort
  $outLog = Join-Path $here 'portal.log'
  # started through WMI so it is independent of this scheduled task and keeps running after the agent exits
  $cmd = 'cmd.exe /c ""{0}" "{1}" >> "{2}" 2>&1"' -f $node, (Join-Path $root 'server.js'), $outLog
  $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $root; ProcessStartupInformation = $startup }
  if ($res.ReturnValue -ne 0) { Log ("could not start the portal (code {0})" -f $res.ReturnValue); return $false }
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 750; if (Test-Portal) { Log 'portal is up'; return $true } }
  Log 'portal did not answer within 30 s'; return $false
}
function Invoke-PortalScan {
  try { $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$PortalPort/api/agent/scan" -TimeoutSec 600 -ErrorAction Stop; Log ("portal processed the inbox drop (waiting files: {0})" -f $r.waiting) }
  catch { Log ('portal scan call failed: ' + $_.Exception.Message) }
}

if ($PortalOnly) { [void](Ensure-Portal); exit 0 }
$portalUp = $false
if (-not $listOnly) { $portalUp = Ensure-Portal }


# ---- "all statements received" e-mails written by the portal (Inbox Drop\outbox\*.json) ----
function Send-Outbox($outlook, $store) {
  $ob = Join-Path $drop 'outbox'
  if (-not (Test-Path $ob)) { return 0 }
  $sentDir = Join-Path $ob 'sent'
  if (-not (Test-Path $sentDir)) { New-Item -ItemType Directory -Path $sentDir -Force | Out-Null }
  $n = 0
  # the same day's summary can be queued several times (e.g. 'Prepare it now' pressed repeatedly): only the newest copy is sent, the others are set aside
  if (-not $DryRun -and -not $NoSend) {
    $pending = @(Get-ChildItem -LiteralPath $ob -Filter '*.json' -File | ForEach-Object { $m = $null; try { $m = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}; if ($m -and $m.kind -eq 'bank-position-summary') { [pscustomobject]@{ File = $_; Msg = $m } } })
    foreach ($g in ($pending | Group-Object { '{0}|{1}' -f $_.Msg.date, $_.Msg.to })) {
      if ($g.Count -le 1) { continue }
      $keep = $g.Group | Sort-Object { [datetime]$_.Msg.created } -Descending | Select-Object -First 1
      $supDir = Join-Path $ob 'superseded'; if (-not (Test-Path $supDir)) { New-Item -ItemType Directory -Path $supDir -Force | Out-Null }
      foreach ($x in $g.Group) { if ($x.File.FullName -ne $keep.File.FullName) { Move-Item -LiteralPath $x.File.FullName -Destination (Join-Path $supDir $x.File.Name) -Force; Log ('outbox: duplicate of the same e-mail set aside: ' + $x.File.Name) } }
    }
  }
  foreach ($f in (Get-ChildItem -LiteralPath $ob -Filter '*.json' -File | Sort-Object Name)) {
    $msg = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $msg.to) { Log ("outbox: '{0}' has no recipients - left in place" -f $f.Name); continue }
    if ($DryRun -and -not $NoSend) { Log ("[dry-run] would {0} '{1}' to {2}" -f $msg.mode, $msg.subject, $msg.to); continue }
    $mail = $outlook.CreateItem(0)
    $mail.Subject = [string]$msg.subject
    $mail.HTMLBody = [string]$msg.html
    $mail.To = [string]$msg.to
    if ($msg.cc) { $mail.CC = [string]$msg.cc }
    foreach ($acc in $outlook.Session.Accounts) { if ($acc.SmtpAddress -eq $cfg.mailbox -or $acc.DisplayName -eq $cfg.mailbox) { $mail.SendUsingAccount = $acc; break } }
    $attached = @()
    if ($msg.attachments) { foreach ($ap in @($msg.attachments)) { if ($ap -and (Test-Path -LiteralPath $ap)) { [void]$mail.Attachments.Add([string]$ap); $attached += $ap } } }
    if ($NoSend) { Log ("[no-send] built '{0}' to {1} ({2} chars of body) and discarded it" -f $msg.subject, $msg.to, ([string]$msg.html).Length); Log ("[no-send] attachments: {0}" -f (($attached | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')); continue }
    if ($msg.mode -eq 'send') { $mail.Send(); Log ("SENT '{0}' to {1}" -f $msg.subject, $msg.to) }
    else { $mail.Save(); [void]$mail.Move($store.GetDefaultFolder(16)); Log ("draft saved: '{0}' (to {1}) - open Drafts and press Send" -f $msg.subject, $msg.to) }
    Move-Item -LiteralPath $f.FullName -Destination (Join-Path $sentDir $f.Name) -Force
    $n++
  }
  return $n
}

$scanned = 0; $matched = 0; $saved = 0; $errorText = $null; $sentCount = 0
try {
  if (-not (Test-Path $drop)) { New-Item -ItemType Directory -Path $drop -Force | Out-Null }
  $state = @{ processed = @(); dispatched = @(); lastRun = $null }
  if (Test-Path $statePath) {
    $s = Get-Content $statePath -Raw | ConvertFrom-Json
    if ($s.processed) { $state.processed = @($s.processed) }
    if ($s.dispatched) { $state.dispatched = @($s.dispatched) }
    if ($s.lastRun)   { $state.lastRun = [datetime]$s.lastRun }
  }
  $done = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($id in $state.processed) { [void]$done.Add([string]$id) }
  $dispDone = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($id in $state.dispatched) { [void]$dispDone.Add([string]$id) }
  $dispKw = if ($cfg.dispatchSubjectKeywords) { @($cfg.dispatchSubjectKeywords | ForEach-Object { $_.ToLower() }) } else { @('payment dispatched') }
  $dispDir = Join-Path $drop 'dispatch'

  $days = if ($LookbackDays -gt 0) { $LookbackDays } elseif ($cfg.lookbackDays) { [int]$cfg.lookbackDays } else { 7 }
  $since = (Get-Date).AddDays(-$days)
  if ($state.lastRun -and ($state.lastRun.AddDays(-1) -lt $since)) { $since = $state.lastRun.AddDays(-1) }   # catch up after being off

  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace('MAPI')
  $store = $null
  foreach ($st in $ns.Stores) { if ($st.DisplayName -eq $cfg.mailbox) { $store = $st; break } }
  if (-not $store) { throw "Mailbox '$($cfg.mailbox)' was not found in Outlook." }
  $folder = $store.GetDefaultFolder(6)           # Inbox
  if ($cfg.folder -and $cfg.folder -ne 'Inbox') { foreach ($part in ($cfg.folder -split '[\\/]')) { if ($part -and $part -ne 'Inbox') { $folder = $folder.Folders.Item($part) } } }

  $us = [Globalization.CultureInfo]::GetCultureInfo('en-US')
  $filter = "[ReceivedTime] >= '" + $since.ToString('g', $us) + "'"
  $items = $folder.Items
  $items.Sort('[ReceivedTime]', $true)
  $items = $items.Restrict($filter)
  Log ("Scanning '{0}' since {1:yyyy-MM-dd HH:mm} ({2} item(s))" -f $cfg.folder, $since, $items.Count)

  $exts   = @($cfg.extensions | ForEach-Object { $_.ToLower() })
  $subKw  = @($cfg.subjectKeywords | ForEach-Object { $_.ToLower() })
  $attKw  = @($cfg.attachmentKeywords | ForEach-Object { $_.ToLower() })
  $minImg = if ($cfg.minImageKB) { [int]$cfg.minImageKB * 1024 } else { 25600 }

  foreach ($item in $items) {
    $scanned++
    try {
      if ($item.Class -ne 43) { continue }                       # mail items only
      $entry = [string]$item.EntryID
      # the daily "Payment Dispatched Details" e-mail has no attachment: its table is saved for the portal (unpresented cheques)
      $subjLower = ([string]$item.Subject).ToLower(); $isDispatch = $false
      foreach ($k in $dispKw) { if ($subjLower.Contains($k)) { $isDispatch = $true; break } }
      if ($isDispatch) {
        if (-not $dispDone.Contains($entry)) {
          $recv = ([datetime]$item.ReceivedTime)
          $shortD = ([BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($entry))) -replace '-', '').Substring(0, 8).ToLower()
          $fin = Join-Path $dispDir ('{0:yyyyMMdd-HHmm}_{1}_dispatch.html' -f $recv, $shortD)
          if ($listOnly) { Log ('[dry-run] dispatch e-mail {0:yyyy-MM-dd HH:mm} | {1}' -f $recv, $item.Subject) }
          else {
            if (-not (Test-Path $dispDir)) { New-Item -ItemType Directory -Path $dispDir -Force | Out-Null }
            $side = [ordered]@{ subject = [string]$item.Subject; from = [string]$item.SenderEmailAddress; received = $recv.ToString('s'); mailbox = [string]$cfg.mailbox; entryShort = $shortD }
            [IO.File]::WriteAllText($fin + '.json', ($side | ConvertTo-Json), $utf8)
            [IO.File]::WriteAllText($fin + '.part', [string]$item.HTMLBody, $utf8)
            Move-Item -LiteralPath ($fin + '.part') -Destination $fin -Force
            [void]$dispDone.Add($entry)
            Log ('saved dispatch details: ' + $item.Subject)
          }
        }
        continue
      }
      if ($done.Contains($entry)) { continue }
      if ($item.Attachments.Count -eq 0) { [void]$done.Add($entry); continue }
      $subject = [string]$item.Subject
      $subjectHit = $false
      foreach ($k in $subKw) { if ($subject.ToLower().Contains($k)) { $subjectHit = $true; break } }

      $sha = [Security.Cryptography.SHA1]::Create()
      $short = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($entry))) -replace '-', '').Substring(0, 8).ToLower()
      $received = ([datetime]$item.ReceivedTime)
      $any = $false

      foreach ($att in $item.Attachments) {
        $name = [string]$att.FileName
        $ext = [IO.Path]::GetExtension($name).ToLower()
        if ($exts -notcontains $ext) { continue }
        # inline signature / logo pictures are not statements
        $inline = $false
        try { $cid = $att.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001F'); if ($cid) { $inline = $true } } catch {}
        if ($inline) { continue }
        if (($ext -in '.jpg', '.jpeg', '.png') -and $att.Size -lt $minImg) { continue }
        $nameHit = $false
        foreach ($k in $attKw) { if ($name.ToLower().Contains($k)) { $nameHit = $true; break } }
        if (-not ($subjectHit -or $nameHit)) { continue }

        $matched++; $any = $true
        $safe = ($name -replace '[\\/:*?"<>|]', '_')
        $final = Join-Path $drop ('{0:yyyyMMdd-HHmm}_{1}_{2}' -f $received, $short, $safe)
        if ($listOnly) { Log ("[dry-run] {0:yyyy-MM-dd HH:mm} | {1} | {2} ({3} KB)" -f $received, $subject, $name, [math]::Round($att.Size / 1024)); continue }
        if (Test-Path $final) { continue }
        $part = $final + '.part'
        $att.SaveAsFile($part)
        $sidecar = [ordered]@{
          originalName = $name; subject = $subject; from = [string]$item.SenderName
          fromAddress = [string]$item.SenderEmailAddress; received = $received.ToString('s'); mailbox = [string]$cfg.mailbox; entryShort = $short
        }
        [IO.File]::WriteAllText($final + '.json', ($sidecar | ConvertTo-Json), $utf8)   # sidecar first, so the portal never sees a file without it
        Move-Item -LiteralPath $part -Destination $final
        $saved++
        Log ("saved: {0}  <-  '{1}'" -f $safe, $subject)
      }
      if (-not $listOnly) { [void]$done.Add($entry) }
    } catch { Log ("skipped one item: " + $_.Exception.Message) }
    finally { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) } catch {} }
  }

  if (-not $listOnly) {
    $keep = @($done | Select-Object -Last 8000)
    $obj = [ordered]@{ lastRun = (Get-Date).ToString('s'); processed = $keep; dispatched = @($dispDone | Select-Object -Last 2000) }
    [IO.File]::WriteAllText($statePath, ($obj | ConvertTo-Json), $utf8)
  }
} catch {
  $errorText = $_.Exception.Message
  Log ("ERROR: " + $errorText)
}

if (-not $listOnly) {
  if (-not $portalUp) { $portalUp = Ensure-Portal }
  if ($portalUp) { Invoke-PortalScan }      # post the balances now and let the portal prepare the notification
}
try { if ($outlook -and $store) { $sentCount = Send-Outbox $outlook $store } } catch { Log ('outbox error: ' + $_.Exception.Message) }

if (-not $listOnly) {
  try {
    $hb = [ordered]@{ time = (Get-Date).ToString('s'); scanned = $scanned; matched = $matched; saved = $saved; sentMail = $sentCount; error = $errorText; mailbox = [string]$cfg.mailbox }
    [IO.File]::WriteAllText((Join-Path $drop 'agent-heartbeat.json'), ($hb | ConvertTo-Json), $utf8)
  } catch {}
}
Log ("done: scanned={0} matched={1} saved={2}" -f $scanned, $matched, $saved)
Trim-Log
