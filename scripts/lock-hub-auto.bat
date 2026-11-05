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
REM SUCCESS IS PROVEN PHONE BY PHONE, never inferred from the absence of a named failure. The
REM walk judges each phone on its OWN output: it counts as enrolled only if its own broadcast
REM printed result=1. Everything else counts against the run, and the exit is then 1:
REM   result=0 on a phone          -> `am broadcast` prints it when the enrol receiver never ran:
REM             the app is missing after a failed install, or Android stopped it first. It
REM             looks like success and is not.
REM   no result line from a phone  -> a cable that dropped, an adb error, a phone that never
REM             answered. None of these leave a result=2, 3 or 5 behind either.
REM   a row that is not `device`   -> unauthorized, offline, authorizing, recovery, whatever else
REM             adb may list: named on the screen, never walked, never silently forgotten.
REM   a phone seen in an earlier round and gone now -> it did not finish.
REM Exit 0 only when every phone seen was walked and answered result=1.
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
set "PEAK=0"
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

echo.
echo === round %ROUND% of %MAXROUNDS% ===
set "OUT=%TEMP%\hoop-hub-run%RUN%-round%ROUND%.txt"
if exist "%OUT%" del "%OUT%"
set "WALKED=0"
set "ENROLLED=0"
set "FAILED=0"
set "NOTREADY=0"

REM ONE LIST, WALKED AND JUDGED PHONE BY PHONE. The loop reads the SAME snapshot of `adb
REM devices` that the readiness check just read -- a second call could disagree with the first,
REM and a phone that fell between the two would be neither walked nor named. Every row is
REM accounted for: `device` is walked, anything else except adb's own `*` daemon lines and the
REM `List of devices attached` header is counted as not ready and printed with the state adb
REM gave it. No row is skipped by POSITION (skip=1): an older adb prints its "* daemon started"
REM lines to stdout, ahead of the header, and a positional skip would then let the header itself
REM through as a phantom not-ready phone. Each walked phone writes to a file of
REM its own and is judged on that file alone, so one phone answering result=1 can never vouch for
REM another that did not. The counters use `set /a`, which needs no delayed expansion, and
REM `if errorlevel`, which is read when it runs.
REM Play Protect's "Verify apps over USB" holds the FIRST adb install for up to an hour while a
REM consent dialog nobody at a bench taps waits on the handset -- then applies the answer it
REM registered, allow on these phones. Switched off for USB installs on each phone first,
REM exactly as the portal's own hub line does.
for /f "usebackq tokens=1,*" %%a in ("%DEVS%") do (
  if "%%b"=="device" (
    set /a WALKED+=1
    echo --- %%a --- > "%TEMP%\hoop-hub-run%RUN%-%%a.txt"
    adb -s %%a shell settings put global verifier_verify_adb_installs 0 >> "%TEMP%\hoop-hub-run%RUN%-%%a.txt" 2>&1
    adb -s %%a install -r "%APK%" >> "%TEMP%\hoop-hub-run%RUN%-%%a.txt" 2>&1
    adb -s %%a shell dpm set-device-owner %ADMIN% >> "%TEMP%\hoop-hub-run%RUN%-%%a.txt" 2>&1
    adb -s %%a shell am broadcast --include-stopped-packages -a %PKG%.ENROL -n %PKG%/.EnrolReceiver -e server %SERVER% -e batch %BATCH% >> "%TEMP%\hoop-hub-run%RUN%-%%a.txt" 2>&1
    type "%TEMP%\hoop-hub-run%RUN%-%%a.txt" >> "%OUT%"
    findstr /c:"result=1," "%TEMP%\hoop-hub-run%RUN%-%%a.txt" >nul
    if errorlevel 1 (set /a FAILED+=1) else (set /a ENROLLED+=1)
    del /f "%TEMP%\hoop-hub-run%RUN%-%%a.txt" >nul 2>&1
  ) else if not "%%a"=="*" if not "%%a"=="List" (
    set /a NOTREADY+=1
    echo NOT READY, skipped: %%a %%b
  )
)
set /a SEEN=WALKED+NOTREADY
if %SEEN% GTR %PEAK% set "PEAK=%SEEN%"
REM NOTHING WALKED. The readiness check passed, but by the time the walk read the snapshot no row
REM was `device` -- or none that survived. Nothing was attempted, and it must not read as success.
if %WALKED% EQU 0 (
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

REM POSITIVE PROOF BEFORE GREEN, PHONE BY PHONE. Everything above only recognises NAMED
REM failures; none of it proves a success. The walk counted, for each phone on its own output,
REM whether it answered result=1. A phone that did not, a row that was not ready, and a phone
REM seen in an earlier round and gone now each make the run red, and every applicable reason is
REM printed before the exit so none is hidden behind another. The green text is printed only on
REM the one path that exits 0.
set "BAD=0"
if %FAILED% GTR 0 (
  echo.
  echo %FAILED% of %WALKED% phones did not answer result=1 ENROLLED. Read the lines above for
  echo each of them: an install that failed, a bare result=0 which means the enrol never ran, a
  echo cable that dropped, or a phone that never answered all end here.
  set "BAD=1"
)
if %NOTREADY% GTR 0 (
  echo.
  echo Phones not ready and skipped: %NOTREADY%, listed above as NOT READY. They are NOT enrolled.
  echo Accept Allow USB debugging on their screens, or replug them, and run this again.
  set "BAD=1"
)
if %SEEN% LSS %PEAK% (
  echo.
  echo A phone that was on the hub in an earlier round is not here now, so it did not finish.
  echo Plug it back in and run this again.
  set "BAD=1"
)
if "%BAD%"=="1" (
  set "RC=1"
  goto finish
)

echo.
echo All %WALKED% phones answered result=1 ENROLLED. Confirm each phone on Devices before boxing
echo it; that is the confirmation that counts, not this terminal.
set "RC=0"
goto finish

REM EVERY WAY OUT OF THE ROUNDS COMES THROUGH HERE, so this run's files never outlive the run --
REM a bench laptop would otherwise collect 2 MB per run in %TEMP% for good.
:finish
del /f "%APK%" "%APK%.part" "%DEVS%" >nul 2>&1
if defined OUT del /f "%OUT%" >nul 2>&1
exit /b %RC%
