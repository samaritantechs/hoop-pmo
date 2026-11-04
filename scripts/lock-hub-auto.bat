@echo off
setlocal EnableExtensions DisableDelayedExpansion

REM =============================================================================================
REM THE HUB COMMAND, RUNNING ITSELF UNTIL IT STOPS NEEDING TO.
REM =============================================================================================
REM   "cant cmd always check if result 3 run the clearing and return to inserting lock,
REM    if result 5 retry the cmd"
REM
REM Every phone on the hub gets install + set-device-owner + the ENROL broadcast, exactly like
REM pasting the hub command from Portal -> Devices -> Sajili simu by hand -- this is that same
REM command, run in a loop that reads the answer instead of a person reading it.
REM
REM Only FOUR result codes are reachable on the batch path (checked against EnrolReceiver.java,
REM not assumed): 1 ENROLLED, 2 TOKEN MISMATCH, 3 NOT DEVICE OWNER, 5 the claim failed for any
REM reason -- no wifi, the office refused it, or the handset could not read its own IMEI, all
REM folded into one code because the message text is what tells them apart, not the number.
REM Code 4 (a malformed token) belongs to the DIRECT -e token path only; the batch path is never
REM handed anything a person typed, so it cannot happen here.
REM
REM   result=3  NOT DEVICE OWNER   -> clear the usual blocking accounts on every phone, retry
REM   result=5  claim failed       -> nothing local to fix; wait a moment and retry as-is
REM   result=2  TOKEN MISMATCH     -> STOPS. A blind retry cannot fix this -- that handset
REM             already holds a DIFFERENT token and needs -e current, one phone at a time.
REM             See docs/DEVICE-LOCKING.md, "When the register and the handset hold different
REM             tokens".
REM   result=0  anywhere          -> STOPS. `am broadcast` prints it when the enrol receiver never
REM             ran -- the app is missing after a failed install, or Android stopped it first.
REM             It looks like success and is not, so it is never allowed to reach the green exit.
REM   no result=1 at all           -> STOPS. Absence of a failure line is not evidence of success:
REM             an install that failed, a cable that dropped, or a phone that never answered
REM             all leave no result=2, 3 or 5 behind.
REM   a phone skipped as not ready -> the others are still done, but the exit is 1: that phone
REM             is not enrolled and the screen names it.
REM   at least one result=1, none of the above -> every result line is result=1. Done, exit 0.
REM
REM RE-RUNNING THE WHOLE HUB ON PHONES THAT ALREADY SUCCEEDED IS SAFE, not wasted risk:
REM `adb install -r` on the same version is a no-op, `set-device-owner` on an owned phone just
REM throws "already set" (harmless -- see the & instead of && below, same as the hub command
REM itself), and the batch hands a phone back its OWN token if it already has one -- "Its own
REM token back if we have ever known one for this IMEI" (api/portal.js). EnrolReceiver treats
REM that as re-arming, not a new identity. That is what lets this retry the ENTIRE hub each
REM round instead of tracking which specific phone still needs what -- simpler, and nothing
REM downstream can mistake a repeat for a swap.
REM
REM WHAT THIS DOES NOT DO: guess at a real signed-in Google account (Settings, or a factory
REM reset skipping sign-in -- no adb command does either), or resolve a token mismatch (that
REM needs a person to choose -e current, one phone, deliberately). Both STOP with the same
REM guidance the portal and the manual already give, rather than hammering a phone that cannot
REM be fixed by trying again.
REM
REM USE:   scripts\lock-hub-auto.bat BATCH
REM   BATCH   the batch id from the hub command in Portal -> Devices -> Sajili simu.
REM           Copy it from there -- this script does not invent one.
REM =============================================================================================

set "PKG=com.samaritantechs.hooploanlock"
set "ADMIN=%PKG%/.LockAdmin"
set "SERVER=https://hoop-pmo.vercel.app"
REM THE CURRENT BUILD, FETCHED BY THE SCRIPT ITSELF -- never a file from Downloads. A browser
REM keeps the first download's name for the OLD file and saves every later one as "(1)", "(2)",
REM so a fixed Downloads name goes on installing the oldest build on the laptop: refused as a
REM downgrade by any phone that has self-updated, and a stale build on a fresh one. The portal's
REM own hub line fetches from the server for exactly this reason (devApkFetch_ in portal.html);
REM this script does the same, every run, into %TEMP% -- always writable, never stale. It lands
REM as .part and is renamed only when curl finished, so a download that stopped halfway can never
REM be installed under the good name. The build number is not known here, so there is no
REM once-per-build cache: slower by one 2 MB download per run, never wrong.
REM
REM EVERY FILE THIS RUN WRITES CARRIES A NAME OF ITS OWN. Two windows running this script at
REM once -- the hour-long waits taught the bench to open a second one -- must never share a
REM file. adb holds the APK open only while an install is running, so between one window's
REM installs the other window's delete or rename would pull it out from under it and the next
REM install would fail with "failed to stat". The device list and each round's output file
REM were fixed names too: one window's delete made the other's `type` and findstr read nothing,
REM and every findstr failing reads, further down, as "no phone answered 2, 3 or 5" -- a green
REM exit on a run that had no result lines at all. One token, three names, all removed at
REM :finish when the run ends by any route the script controls. A window closed or Ctrl+C'd
REM mid-run never reaches :finish and leaves its files behind (about 2 MB); they are safe to
REM delete from %TEMP% once that window is gone.
set "RUN=%RANDOM%%RANDOM%%RANDOM%"
set "APK=%TEMP%\HOOPLOAN-Lock-run%RUN%.apk"
set "DEVS=%TEMP%\hoop-hub-run%RUN%-devices.txt"
set "BATCH=%~1"
set "MAXROUNDS=5"
set "CLEARED=0"
set /a ROUND=0

if "%BATCH%"=="" (
  echo usage: lock-hub-auto BATCH
  echo   BATCH is the batch id from the hub command in Portal -^> Devices -^> Sajili simu.
  exit /b 2
)
echo Fetching the current lock app from %SERVER% ...
curl -fsSL --connect-timeout 20 --speed-time 30 --speed-limit 1000 --retry 2 -o "%APK%.part" "%SERVER%/HOOPLOAN-Lock.apk"
if errorlevel 1 (
  del /f "%APK%.part" >nul 2>&1
  echo Could not fetch %SERVER%/HOOPLOAN-Lock.apk -- check this laptop's internet, then run again.
  echo Nothing was done to any phone.
  exit /b 2
)
REM THE RENAME IS CHECKED ON ITS OWN RESULT. cmd's move can refuse -- the fresh .part held for a
REM moment by an antivirus scan, say -- and prints its reason to stderr, which the >nul above
REM does not cover. Unchecked, the script would carry on to a name that no longer exists. The
REM path is quoted wherever it is echoed inside a block: a ) or an & in the Windows user name,
REM which %TEMP% carries, would otherwise end the block early.
move /y "%APK%.part" "%APK%" >nul
if errorlevel 1 (
  del /f "%APK%.part" >nul 2>&1
  echo The download could not be put in place as "%APK%" -- run again.
  echo Nothing was done to any phone.
  exit /b 2
)
if not exist "%APK%" (
  del /f "%APK%.part" >nul 2>&1
  echo The download did not land as "%APK%" -- run again.
  echo Nothing was done to any phone.
  exit /b 2
)

:round
set /a ROUND+=1
if %ROUND% GTR %MAXROUNDS% (
  echo.
  echo Stopped after %MAXROUNDS% rounds. Read the output above for whichever phone is still
  echo not on result=1 and act on it by hand -- see docs/DEVICE-LOCKING.md.
  set "RC=1"
  goto finish
)

adb devices > "%DEVS%"
findstr /e /c:"device" "%DEVS%" >nul
if errorlevel 1 (
  echo No phones ready. Check the cable and "Allow USB debugging" on each screen.
  set "RC=2"
  goto finish
)
REM A PHONE THAT IS NOT READY IS NAMED, NEVER SKIPPED IN SILENCE. The walk below keeps only the
REM rows adb calls `device`, so a handset whose "Allow USB debugging" prompt was never tapped
REM would otherwise be left out of a run that still ended "every result line is result=1" --
REM true of the lines that exist, and the tenth phone never mentioned.
set "SKIPPED=0"
findstr /i /c:"unauthorized" /c:"offline" /c:"no permissions" "%DEVS%"
if not errorlevel 1 (
  set "SKIPPED=1"
  echo.
  echo The phones listed just above are not ready and are skipped this round. Accept Allow USB
  echo debugging on their screens, or replug them, and run this again for those.
)
del "%DEVS%" >nul 2>&1

echo.
echo === round %ROUND% of %MAXROUNDS% ===
set "OUT=%TEMP%\hoop-hub-run%RUN%-round%ROUND%.txt"
if exist "%OUT%" del "%OUT%"

for /f "skip=1 tokens=1,2" %%a in ('adb devices') do @if "%%b"=="device" (
  echo --- %%a --- >> "%OUT%"
  REM Play Protect's "Verify apps over USB" holds the FIRST adb install for up to an hour while
  REM a consent dialog nobody at a bench taps waits on the handset -- then applies the answer
  REM it registered, allow on these phones. Switched off for USB installs on each phone first,
  REM exactly as the portal's own hub line does.
  adb -s %%a shell settings put global verifier_verify_adb_installs 0 >> "%OUT%" 2>&1
  adb -s %%a install -r "%APK%" >> "%OUT%" 2>&1
  adb -s %%a shell dpm set-device-owner %ADMIN% >> "%OUT%" 2>&1
  adb -s %%a shell am broadcast --include-stopped-packages -a %PKG%.ENROL -n %PKG%/.EnrolReceiver -e server %SERVER% -e batch %BATCH% >> "%OUT%" 2>&1
)
REM NO FILE MEANS NO PHONE WAS WALKED. The check above and the loop are two separate `adb
REM devices` calls, so the last phone can drop, or adb restart, between them; the loop body
REM never runs, the round's file is never written, and every findstr below then fails -- which
REM would fall through to the "every result line above should read result=1" ending and exit
REM 0 on a run in which nothing was attempted.
if not exist "%OUT%" (
  echo No phone was ready when the walk started -- nothing was enrolled. Check the cable and
  echo "Allow USB debugging" on each screen, then run this again.
  set "RC=2"
  goto finish
)
type "%OUT%"

findstr /c:"VERSION_DOWNGRADE" "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo Note: at least one phone already has a NEWER app than the build the server is serving
  echo right now. That phone keeps its newer app and this still works. It means a lock release
  echo is mid-way -- the version file has landed and the APK build has not -- and the next run
  echo in a few minutes will fetch the newer one.
)

findstr /c:"result=2," "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo At least one phone answered TOKEN MISMATCH. Retrying will not fix this: that handset
  echo already holds a DIFFERENT token. Enrol it on its own with -e current -- see
  echo docs/DEVICE-LOCKING.md, "When the register and the handset hold different tokens".
  del "%OUT%" >nul 2>&1
  set "RC=1"
  goto finish
)

findstr /c:"result=3," "%OUT%" >nul
if not errorlevel 1 (
  if "%CLEARED%"=="1" (
    echo.
    echo Still NOT DEVICE OWNER on at least one phone after clearing the usual accounts once.
    echo A real signed-in Google account needs Settings on that handset, or a factory reset
    echo with the sign-in skipped -- no adb command does either. Unplug it, deal with the
    echo rest, then run this again for that one on its own.
    del "%OUT%" >nul 2>&1
    set "RC=1"
    goto finish
  )
  echo.
  echo Clearing the accounts that usually block set-device-owner, on every phone still here...
  for /f "skip=1 tokens=1,2" %%a in ('adb devices') do @if "%%b"=="device" (
    adb -s %%a shell pm uninstall --user 0 com.google.android.apps.tachyon >nul 2>&1
    adb -s %%a shell pm uninstall --user 0 com.microsoft.office.outlook >nul 2>&1
    adb -s %%a shell pm uninstall --user 0 com.microsoft.skydrive >nul 2>&1
  )
  set "CLEARED=1"
  del "%OUT%" >nul 2>&1
  goto round
)

findstr /c:"result=5," "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo At least one phone could not enrol yet -- no wifi, a stale batch, or it could not read
  echo its own IMEI; the line above names which. Waiting a moment, then trying the whole hub
  echo again...
  del "%OUT%" >nul 2>&1
  ping -n 6 127.0.0.1 >nul
  goto round
)

REM POSITIVE PROOF BEFORE GREEN. Everything above only recognises named failures; nothing yet
REM proves a success. result=0 is the receiver never having run, and it matches none of the
REM patterns above because they all end in a comma.
findstr /c:"result=0" "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo At least one phone answered result=0 with no message. The enrol did not run there: the
  echo app is missing after a failed install, or Android stopped it before it finished. This
  echo line looks like success and is not. Read the install line above that phone, fix it, and
  echo run this again.
  set "RC=1"
  goto finish
)

findstr /c:"result=1," "%OUT%" >nul
if errorlevel 1 (
  echo.
  echo No phone answered result=1 ENROLLED, so nothing was confirmed. Read the lines above: an
  echo install that failed, a cable that dropped, or a phone that never answered all end here.
  set "RC=1"
  goto finish
)

echo.
echo No phone answered result=2, 3 or 5 -- every result line above should read result=1
echo ENROLLED. Confirm each phone on Devices before boxing it; that is the confirmation that
echo counts, not this terminal.
if "%SKIPPED%"=="1" (
  echo.
  echo But at least one phone was not ready and was skipped -- it is listed above and it is NOT
  echo enrolled. Fix it and run this again for that phone.
  set "RC=1"
  goto finish
)
set "RC=0"
goto finish

REM EVERY WAY OUT OF THE ROUNDS COMES THROUGH HERE, so this run's files never outlive the run --
REM a bench laptop would otherwise collect 2 MB per run in %TEMP% for good.
:finish
del /f "%APK%" "%APK%.part" "%DEVS%" >nul 2>&1
if defined OUT del /f "%OUT%" >nul 2>&1
exit /b %RC%
