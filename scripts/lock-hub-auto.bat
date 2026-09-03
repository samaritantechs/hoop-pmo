@echo off
setlocal

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
REM   neither 2, 3 nor 5 anywhere  -> every result line is result=1. Done.
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
set "APK=%USERPROFILE%\Downloads\HOOPLOAN-Lock.apk"
set "BATCH=%~1"
set "MAXROUNDS=5"
set "CLEARED=0"
set /a ROUND=0

if "%BATCH%"=="" (
  echo usage: lock-hub-auto BATCH
  echo   BATCH is the batch id from the hub command in Portal -^> Devices -^> Sajili simu.
  exit /b 2
)
if not exist "%APK%" (
  echo APK not found: %APK%
  echo Download it from %SERVER%/HOOPLOAN-Lock.apk first.
  exit /b 2
)

:round
set /a ROUND+=1
if %ROUND% GTR %MAXROUNDS% (
  echo.
  echo Stopped after %MAXROUNDS% rounds. Read the output above for whichever phone is still
  echo not on result=1 and act on it by hand -- see docs/DEVICE-LOCKING.md.
  exit /b 1
)

adb devices > "%TEMP%\hoop-devices.txt"
findstr /e /c:"device" "%TEMP%\hoop-devices.txt" >nul
if errorlevel 1 (
  echo No phones ready. Check the cable and "Allow USB debugging" on each screen.
  del "%TEMP%\hoop-devices.txt" >nul 2>&1
  exit /b 2
)
del "%TEMP%\hoop-devices.txt" >nul 2>&1

echo.
echo === round %ROUND% of %MAXROUNDS% ===
set "OUT=%TEMP%\hoop-hub-round%ROUND%.txt"
if exist "%OUT%" del "%OUT%"

for /f "skip=1 tokens=1,2" %%a in ('adb devices') do @if "%%b"=="device" (
  echo --- %%a --- >> "%OUT%"
  adb -s %%a install -r "%APK%" >> "%OUT%" 2>&1
  adb -s %%a shell dpm set-device-owner %ADMIN% >> "%OUT%" 2>&1
  adb -s %%a shell am broadcast --include-stopped-packages -a %PKG%.ENROL -n %PKG%/.EnrolReceiver -e server %SERVER% -e batch %BATCH% >> "%OUT%" 2>&1
)
type "%OUT%"

findstr /c:"VERSION_DOWNGRADE" "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo Note: at least one phone already has a NEWER app than the file in Downloads. That
  echo phone keeps its newer app and this still works -- but update your Downloads copy from
  echo %SERVER%/HOOPLOAN-Lock.apk so fresh phones get it too.
)

findstr /c:"result=2," "%OUT%" >nul
if not errorlevel 1 (
  echo.
  echo At least one phone answered TOKEN MISMATCH. Retrying will not fix this: that handset
  echo already holds a DIFFERENT token. Enrol it on its own with -e current -- see
  echo docs/DEVICE-LOCKING.md, "When the register and the handset hold different tokens".
  del "%OUT%" >nul 2>&1
  exit /b 1
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
    exit /b 1
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

echo.
echo No phone answered result=2, 3 or 5 -- every result line above should read result=1
echo ENROLLED. Confirm each phone on Devices before boxing it; that is the confirmation that
echo counts, not this terminal.
del "%OUT%" >nul 2>&1
exit /b 0
