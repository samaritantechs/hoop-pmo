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
# Add -Was <the token it holds now> to move a handset onto a NEW token, with no factory reset:
# the receiver takes a second token from anybody who can name the first, which only the office
# can. Re-running with the SAME token needs nothing -- it re-arms a phone that has gone quiet.
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
    # Move a handset onto a NEW token: pass the one it holds now, which is what EnrolReceiver
    # requires as proof before it will accept a replacement. This used to run `pm clear`, which
    # is refused on a Device Owner app (see the note below the device scan) and did nothing.
    [string]$Was,
    # THE WAY BACK OUT, for a handset the server can no longer reach. See the -Release block
    # below, and docs/DEVICE-LOCKING.md, "The way back out, over the cable".
    [switch]$Release,
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
add -Was <the token it holds now> to move a phone onto a new token (no factory reset).

to RELEASE a phone the portal cannot reach (unlock it and hand it back):
                     .\lock-bench.ps1 -Release -Token <that phone's token>
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

# THE WAY BACK OUT, for a handset the office cannot reach.
# =============================================================================================
# A release normally travels through the portal: press Achia, and the next beat unlocks the
# phone and steps the app down as Device Owner. That needs a handset that is still listening.
# When it is not -- the register says imeachiwa and the phone has said nothing for a day -- the
# shell's own routes are all shut: `pm clear` is refused (CLEAR_APP_USER_DATA), so is
# `dpm remove-active-admin` ("non-test admin"), so is `pm uninstall`
# (DELETE_FAILED_DEVICE_POLICY_MANAGER), and factory reset is blocked by our own restriction.
#
# `adb install -r` is NOT shut: setUninstallBlocked blocks uninstall, not update. So a newer
# APK goes on over the top, and the app does for itself what the shell may not.
if ($Release) {
    if (-not $Token) { Fail "-Release needs the phone's own token:  -Release -Token <token>" }
    foreach ($s in $serials) {
        Write-Host "  .  $s  releasing  " -NoNewline
        $null = adb -s $s install -r "$Apk" 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Host 'FAILED at install' -ForegroundColor Red; continue }
        # --include-stopped-packages IS NOT OPTIONAL: install -r leaves the app STOPPED, and a
        # stopped app hears no broadcast. Without it, result=0 and nothing happens.
        $out = (adb -s $s shell am broadcast --include-stopped-packages `
                    -a "$pkg.RELEASE" -n "$pkg/.ReleaseReceiver" `
                    -e token $Token 2>&1) -join ' '
        if ($out -match 'TOKEN MISMATCH') {
            Write-Host 'WRONG TOKEN - nothing was changed. Check this phone''s register row.' -ForegroundColor Red
        } elseif ($out -match 'PARTIAL') {
            # Not a failure: the phone is unlocked and holds no token, which is the state a
            # fresh enrol is accepted in. Something else still owns it -- on Watu stock that is
            # usually Samsung Knox Guard. `adb shell dumpsys device_policy` names the admins.
            Write-Host 'PARTIAL - unlocked and token cleared, but another admin still owns it.' -ForegroundColor Yellow
            Write-Host '           You can re-enrol and re-lock it as it is. Run: adb shell dumpsys device_policy'
        } elseif ($out -match 'RELEASED') {
            Write-Host 'RELEASED - ordinary phone again.' -ForegroundColor Green
        } else {
            $why = if ($out -match 'data="([^"]*)"') { $matches[1] } else { $out }
            Write-Host "FAILED - $why" -ForegroundColor Red
        }
    }
    exit 0
}

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
    # -Was is what lets a handset move onto a different token: the receiver takes a second one
    # from anybody who can name the first, which only the office can.
    $extra = if ($Was) { @('-e', 'current', $Was) } else { @() }
    $out = (adb -s $s shell am broadcast --include-stopped-packages `
                -a "$pkg.ENROL" -n "$pkg/.EnrolReceiver" `
                -e server $Server -e token $token @extra 2>&1) -join ' '
    if ($out -match 'ALREADY ENROLLED') {
        # Holding a DIFFERENT token, which is the only case left that refuses: a re-run with
        # the same token now re-arms the phone and answers ENROLLED.
        Write-Host 'ALREADY ENROLLED under another token (add -Was <the token it holds now>)' -ForegroundColor Yellow
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
