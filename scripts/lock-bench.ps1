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
# ONE PHONE, no file needed -- the station hits this constantly (a redo, a replacement, one
# that failed the first time), and writing a two-word text file for it is friction with no
# purpose:
#
#     powershell -ExecutionPolicy Bypass -File scripts\lock-bench.ps1 -Token <that token>
#
# Add -ReEnrol to either form when the handset already holds a token from an earlier session.
# It clears the app's stored data first so a new token is accepted; Device Owner survives the
# clear, so this replaces a token without a factory reset.
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
#
# THE ONE CASE WHERE THAT MATCH IS SKIPPED, because it is protecting against nothing: one
# phone connected and one token to give it. There is no other handset to confuse it with, so
# the pairing cannot be wrong -- and skipping it also skips the "could not read this phone's
# IMEI" failure, which is precisely what stops a single-phone job dead on Android 10+ where
# the modem read is refused until Device Owner takes.
# =============================================================================================

param(
    [Parameter(Position = 0)][string]$TokenFile,
    # ONE PHONE, WITHOUT A FILE. Making a two-word text file to provision a single handset is
    # friction with no purpose, and the station hits the single-phone case constantly -- a
    # redo, a replacement, one that failed the first time.
    [string]$Token,
    # Re-provision a handset that already holds a token: clears the app's stored data first,
    # so EnrolReceiver will accept a new one. Device Owner survives the clear, which is why
    # this works without a factory reset.
    [switch]$ReEnrol,
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
if (-not $Token -and -not $TokenFile) {
    Fail @"
usage, one phone:    .\lock-bench.ps1 -Token f1b942f3991b43dd8d8f857535a0d468
usage, many phones:  .\lock-bench.ps1 tokens.txt
add -ReEnrol to either if the phone already holds a token from a previous session.
"@
}
if ($TokenFile -and -not (Test-Path $TokenFile)) { Fail "Token file not found: $TokenFile" }
if (-not (Test-Path $Apk))       { Fail "APK not found: $Apk`nPass the right path:  -Apk C:\path\to\HOOPLOAN-Lock.apk" }

# IMEI -> token. Tolerates commas, tabs, blank lines and # comments, because this file gets
# pasted together by hand at six in the morning.
$tokenOf = @{}
if ($TokenFile) {
    foreach ($line in Get-Content $TokenFile) {
        $clean = ($line -split '#')[0] -replace '[,\t]', ' '
        $parts = $clean -split '\s+' | Where-Object { $_ -ne '' }
        if ($parts.Count -ge 2) { $tokenOf[$parts[0]] = $parts[1] }
    }
    Write-Host "Loaded $($tokenOf.Count) tokens from $TokenFile"
}

$serials = @(adb devices | Select-Object -Skip 1 |
             Where-Object { $_ -match '^(\S+)\s+device$' } |
             ForEach-Object { $matches[1] })
if ($serials.Count -eq 0) {
    Fail "No phones ready.`nCheck the cable, and that 'Allow USB debugging' was accepted on the phone's own screen."
}
Write-Host "Phones connected: $($serials.Count)"

# THE PAIRING RULE, AND WHY IT CAN SOMETIMES BE SKIPPED ENTIRELY.
# =============================================================================================
#   "the locking method for bulk should be one that works wether there is one connected
#    phone or more"
#
# Matching each handset to its token by IMEI exists for exactly one reason: with several
# phones on the bench there is a wrong pairing to make, and a token written into the wrong
# handset makes that phone answer for another customer's loan.
#
# When there is ONE phone and ONE token, that danger does not exist -- there is no other
# phone to confuse it with. So the match is skipped, and with it the whole "could not read
# this handset's IMEI" failure, which is the case that stops a single-phone job dead on
# Android 10+ where the modem read is refused. Same command, both jobs, and the safety only
# where it buys something.
$single = ''
if ($Token) {
    $single = $Token
} elseif ($serials.Count -eq 1 -and $tokenOf.Count -eq 1) {
    $single = @($tokenOf.Values)[0]
    Write-Host "One phone, one token: pairing them directly (no IMEI match needed)." -ForegroundColor Cyan
}
Write-Host ''

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

    $token = if ($single) { $single }
             elseif ($imei -and $tokenOf.ContainsKey($imei)) { $tokenOf[$imei] }
             else { '' }

    if (-not $token) {
        # NEVER GUESS. See the header.
        $shown = if ($imei) { $imei } else { 'none' }
        Write-Host "  ?  $s - could not match an IMEI (read: $shown). Left for the manual pass." -ForegroundColor Yellow
        $unmatched += $s
        continue
    }

    Write-Host "  .  $s  imei $(if ($imei) { $imei } else { '(not read)' })  " -NoNewline

    # -ReEnrol first, so a handset that already holds a token can take a new one. Device
    # Owner survives `pm clear`; only the app's own stored data goes.
    if ($ReEnrol) { $null = adb -s $s shell pm clear $pkg 2>&1 }

    $null = adb -s $s install -r "$Apk" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'FAILED at install' -ForegroundColor Red; $failed++; continue
    }

    # Order is not optional: owner FIRST, then the token. The other way round the receiver
    # drops the token and adb still prints a success-looking line. That cost an evening once.
    $owner = (adb -s $s shell dpm set-device-owner $admin 2>&1) -join ' '
    # "already set" is not a failure -- it is a handset that was provisioned before, which is
    # the ordinary state of every phone being redone. It arrives as a red Java stack trace,
    # which is not how a success usually looks, and treating it as one stopped these jobs dead.
    if ($owner -notmatch 'Success' -and $owner -notmatch 'already set|already an admin') {
        Write-Host 'FAILED at set-device-owner - phone must have NO google account and NO screen lock' -ForegroundColor Red
        $failed++; continue
    }

    # EnrolReceiver answers with a result code and a readable message, so a refusal says why
    # instead of printing result=0 and meaning nothing.
    # --include-stopped-packages IS NOT OPTIONAL. See the note at the top of this file.
    $out = (adb -s $s shell am broadcast --include-stopped-packages `
                -a "$pkg.ENROL" -n "$pkg/.EnrolReceiver" `
                -e server $Server -e token $token 2>&1) -join ' '
    if ($out -match 'ALREADY ENROLLED') {
        # Finished already, and only confusing if reported as a failure. Add -ReEnrol to
        # deliberately replace the token this handset is holding.
        Write-Host 'ALREADY ENROLLED (add -ReEnrol to replace its token)' -ForegroundColor Yellow
        $ok++
    } elseif ($out -match 'ENROLLED') {
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
    adb -s <serial> shell am broadcast --include-stopped-packages -a $pkg.ENROL -n $pkg/.EnrolReceiver -e server $Server -e token THAT_PHONES_TOKEN

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
