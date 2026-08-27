# =============================================================================================
# THE BENCH SCRIPT, FOR WINDOWS -- 200 phones a day, one command instead of six hundred.
# =============================================================================================
# The station runs Windows. lock-bench.sh is a Linux script and cannot run there at all:
#
#     C:\Users\marki>./scripts/lock-bench.sh tokens.txt
#     '.' is not recognized as an internal or external command
#
# This is the same thing in PowerShell, so the operator does not have to install Git Bash or
# WSL to lock a phone. Keep the two in step -- if the enrol commands change, they change here
# too, and test/smoke.test.mjs holds both to the same command order.
#
# ---------------------------------------------------------------------------------------------
# USE, from the black cmd window:
#
#     powershell -ExecutionPolicy Bypass -File scripts\lock-bench.ps1 tokens.txt
#
# Or double-click scripts\lock-bench.bat, which is that line and nothing else.
#
#   tokens.txt -- one phone per line, IMEI then token, from Devices -> + Sajili simu:
#
#       351388334583295 f1b942f3991b43dd8d8f857535a0d468
#       351388334583296 a2c051e4aa2c54ee9e9f968646b1f579
#
# Every phone must already be at the point where `adb devices` lists it as `device` -- the
# setup wizard skipped, Build number tapped seven times, USB debugging on, and "Allow USB
# debugging" accepted ON THE PHONE. That tapping is the part no script can reach, and it is
# what actually costs the day: about three minutes a phone, so 200 phones is roughly ten
# hours however this is written. What the script buys is parallelism -- the phones run their
# commands while the operator is already tapping through the next one.
#
# WHICH TOKEN GOES TO WHICH PHONE. adb knows a handset by its USB serial, which is not the
# IMEI and is not in the token file. So each phone is asked for its own IMEI and matched on
# that. A phone that will not report one is set aside and listed at the end for a manual pass
# -- never guessed, because a token written into the wrong handset makes that phone answer
# for another customer's loan, and the only way back is a factory reset.
# =============================================================================================

param(
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [string]$Apk = "$env:USERPROFILE\Downloads\HOOPLOAN-Lock.apk",
    [string]$Server = 'https://hoop-pmo.vercel.app'
)

$ErrorActionPreference = 'Continue'
$pkg   = 'com.samaritantechs.hooploanlock'
$admin = "$pkg/.LockAdmin"

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 2 }

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Fail "adb not found. Install it first:  winget install --id Google.PlatformTools -e`nThen close this window and open a new one."
}
if (-not (Test-Path $TokenFile)) { Fail "Token file not found: $TokenFile" }
if (-not (Test-Path $Apk))       { Fail "APK not found: $Apk`nPass the right path:  -Apk C:\path\to\HOOPLOAN-Lock.apk" }

# IMEI -> token. Tolerates commas, tabs, blank lines and # comments, because this file gets
# pasted together by hand at six in the morning.
$tokenOf = @{}
foreach ($line in Get-Content $TokenFile) {
    $clean = ($line -split '#')[0] -replace '[,\t]', ' '
    $parts = $clean -split '\s+' | Where-Object { $_ -ne '' }
    if ($parts.Count -ge 2) { $tokenOf[$parts[0]] = $parts[1] }
}
Write-Host "Loaded $($tokenOf.Count) tokens from $TokenFile"

$serials = @(adb devices | Select-Object -Skip 1 |
             Where-Object { $_ -match '^(\S+)\s+device$' } |
             ForEach-Object { $matches[1] })
if ($serials.Count -eq 0) {
    Fail "No phones ready.`nCheck the cable, and that 'Allow USB debugging' was accepted on the phone's own screen."
}
Write-Host "Phones connected: $($serials.Count)`n"

$ok = 0; $failed = 0; $unmatched = @()

foreach ($s in $serials) {
    # The handset's own idea of its IMEI. The digits come back inside the quoted ASCII column
    # of a Parcel dump; empty on a phone whose build refuses the read, which is ordinary
    # rather than a fault -- see Imei.java.
    $imei = ''
    try {
        $raw = (adb -s $s shell service call iphonesubinfo 1 2>$null) -join ''
        $digits = ([regex]::Matches($raw, "'([^']*)'") | ForEach-Object { $_.Groups[1].Value }) -join ''
        $digits = $digits -replace '\D', ''
        if ($digits.Length -ge 15) { $imei = $digits.Substring($digits.Length - 15) }
    } catch { }

    $token = if ($imei -and $tokenOf.ContainsKey($imei)) { $tokenOf[$imei] } else { '' }

    if (-not $token) {
        # NEVER GUESS. See the header.
        $shown = if ($imei) { $imei } else { 'none' }
        Write-Host "  ?  $s - could not match an IMEI (read: $shown). Left for the manual pass." -ForegroundColor Yellow
        $unmatched += $s
        continue
    }

    Write-Host "  .  $s  imei $imei  " -NoNewline

    $null = adb -s $s install -r "$Apk" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'FAILED at install' -ForegroundColor Red; $failed++; continue
    }

    # Order is not optional: owner FIRST, then the token. The other way round the receiver
    # drops the token and adb still prints a success-looking line. That cost an evening once.
    $owner = (adb -s $s shell dpm set-device-owner $admin 2>&1) -join ' '
    if ($owner -notmatch 'Success') {
        Write-Host 'FAILED at set-device-owner - phone must have NO google account and NO screen lock' -ForegroundColor Red
        $failed++; continue
    }

    # EnrolReceiver answers with a result code and a readable message, so a refusal says why
    # instead of printing result=0 and meaning nothing.
    $out = (adb -s $s shell am broadcast -a "$pkg.ENROL" -n "$pkg/.EnrolReceiver" `
                -e server $Server -e token $token 2>&1) -join ' '
    if ($out -match 'ENROLLED') {
        Write-Host 'ENROLLED' -ForegroundColor Green; $ok++
    } else {
        $why = if ($out -match 'data="([^"]*)"') { $matches[1] } else { $out }
        Write-Host "FAILED - $why" -ForegroundColor Red; $failed++
    }
}

Write-Host "`nenrolled $ok . failed $failed . unmatched $($unmatched.Count)"

if ($unmatched.Count -gt 0) {
    Write-Host @"

THE UNMATCHED ONES, one at a time. Read the IMEI off the box, then:

    adb -s <serial> install -r "$Apk"
    adb -s <serial> shell dpm set-device-owner $admin
    adb -s <serial> shell am broadcast -a $pkg.ENROL -n $pkg/.EnrolReceiver -e server $Server -e token THAT_PHONES_TOKEN

Serials waiting: $($unmatched -join ' ')
"@ -ForegroundColor Yellow
}

Write-Host @"

NOW LOCK THEM BEFORE THEY GO BACK IN THE BOX. Enrolling a phone does not lock it, and an
order to lock only reaches a handset that is ONLINE - a boxed phone with no SIM never hears
it. So while these are still on the bench:

    Portal -> Devices -> tick them -> Funga -> reason ("stock, unsold")
    Wait for the register to read CONFIRMED (imefungwa), not pending (imeagizwa . bado).
    Only then power them off and box them.

From that moment each phone carries its own lock: it comes back up locked with no network at
all, through as many reboots as anyone tries, and cannot be factory reset out of it.
"@ -ForegroundColor Cyan
