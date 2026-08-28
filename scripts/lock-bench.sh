#!/usr/bin/env bash
# =============================================================================================
# THE BENCH SCRIPT -- 200 phones a day, one command instead of six hundred.
# =============================================================================================
#   "Now sipho receives like 200 phones per day, any shotcut further?"
#
# Three adb commands turn a boxed handset into a locked one, and every one of them has to be
# typed with that phone's own token pasted into it. At 200 a day that is 600 commands and 200
# copy-pastes, and a token pasted into the wrong phone is a handset that answers for somebody
# else's loan.
#
# So: plug in as many phones as the hub has ports, run this once, and it does all of them.
#
# WHAT IT DOES NOT FIX, said plainly at the top so nobody plans a day around a wrong number.
# The adb part was never the slow part -- it is about ten seconds a phone. The cost is the
# tapping this script cannot reach: Samsung's setup wizard with every account skipped, then
# Settings -> About phone -> Software information -> Build number tapped seven times, then
# Developer options -> USB debugging, then "Allow USB debugging?" accepted on the phone's own
# screen. Two to three minutes each, 200 phones, call it ten hours whatever we write here.
#
# The shortcut this DOES buy is parallelism: the phones run their commands while the operator
# is already tapping through the next one's wizard. A ten-port powered hub is the difference
# between ten hours and one or two, and that is the whole reason this script takes a list
# rather than a single serial.
#
# The only true zero-touch route is Samsung Knox Mobile Enrolment, where the seller registers
# the handsets to us before they ship and they provision themselves at first boot with nobody
# touching them. It needs buying through a Knox-participating authorised reseller. Worth asking
# your suppliers; until one says yes, this is the fast way.
#
# ---------------------------------------------------------------------------------------------
# USE
#   1. Portal -> Devices -> "+ Sajili simu": paste the whole day's IMEIs at once (up to 500).
#      Copy the IMEI/token list it shows you -- that screen shows each token ONCE.
#   2. Save it as a plain text file, one phone per line, IMEI and token separated by a space
#      or a comma:
#
#         351388334583295 f1b942f3991b43dd8d8f857535a0d468
#         351388334583296 a2c051e4aa2c54ee9e9f968646b1f579
#
#   3. Get every phone to the point where `adb devices` lists it as `device` (the tapping
#      above). Then:
#
#         ./scripts/lock-bench.sh tokens.txt
#
#      It walks every connected phone, does all three steps, and prints one line each.
#
# WHICH TOKEN GOES TO WHICH PHONE. adb identifies a handset by its USB serial, which is not
# the IMEI and is not in the token list. So the script asks each phone for its own IMEI over
# adb and matches on that. Phones that will not report one (Android 10+ before Device Owner
# takes, on some builds) are handled at the end, one at a time, with the operator reading the
# IMEI off the box -- never guessed, because a wrong token is worse than no token.
# =============================================================================================
set -u

PKG=com.samaritantechs.hooploanlock
ADMIN="$PKG/.LockAdmin"
APK="${APK:-public/HOOPLOAN-Lock.apk}"
SERVER="${SERVER:-https://hoop-pmo.vercel.app}"

# ONE PHONE, WITHOUT A FILE. TOKEN=<token> covers the case the station hits constantly -- a
# redo, a replacement, one that failed the first time -- where writing a two-word text file
# is friction with no purpose.
#
# WAS=<the token it holds now> moves a handset onto a NEW token without a factory reset. The
# receiver takes a second token from anybody who can name the first one, which only the office
# can. Re-running with the SAME token needs nothing: it re-arms the phone and reports in.
#
# This used to be REENROL=1, which ran `pm clear` -- refused on a Device Owner app, as the
# comment below the device scan in this same file has always said. It did nothing, silently,
# and left the factory reset as the only real route to a new token.
TOKEN="${TOKEN:-}"
WAS="${WAS:-}"
# THE WAY BACK OUT: RELEASE=1 TOKEN=<token> unlocks a handset the office cannot reach and
# hands it back. See the block below the device scan, and docs/DEVICE-LOCKING.md.
RELEASE="${RELEASE:-}"
TOKENS="${1:-}"
if [ -z "$TOKEN" ] && { [ -z "$TOKENS" ] || [ ! -f "$TOKENS" ]; }; then
    cat <<USAGE
usage, one phone:    TOKEN=<that token> $0
usage, many phones:  $0 <token-list.txt>    (one 'IMEI token' per line, from Devices -> Sajili simu)
to move a phone onto a NEW token (no factory reset):
                     WAS=<the token it holds now> TOKEN=<the new one> $0

to RELEASE a phone the portal cannot reach (unlock it and hand it back):
                     RELEASE=1 TOKEN=<that phone's token> $0
USAGE
    exit 2
fi
[ -f "$APK" ] || { echo "APK not found: $APK   (set APK=/path/to/HOOPLOAN-Lock.apk)"; exit 2; }

# IMEI -> token. Tolerates commas, tabs, blank lines and # comments, because this file is
# pasted together by hand at six in the morning.
declare -A TOKEN_OF
if [ -n "$TOKENS" ] && [ -f "$TOKENS" ]; then
    while IFS= read -r line; do
        line="${line%%#*}"
        line="$(printf '%s' "$line" | tr ',\t' '  ')"
        set -- $line
        [ $# -ge 2 ] || continue
        TOKEN_OF["$1"]="$2"
    done < "$TOKENS"
    echo "Loaded ${#TOKEN_OF[@]} tokens from $TOKENS"
fi

SERIALS=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
[ -n "$SERIALS" ] || { echo "No phones ready. Check the cable, and that 'Allow USB debugging' was accepted."; exit 1; }
N_PHONES=$(printf '%s\n' "$SERIALS" | wc -l | tr -d ' ')
echo "Phones connected: $N_PHONES"

# THE WAY BACK OUT, for a handset the office cannot reach.
# =============================================================================================
# A release normally travels through the portal: press Achia, and the next beat unlocks the
# phone and steps the app down as Device Owner. That needs a handset still listening. When it
# is not, every shell route out is shut: `pm clear` is refused (CLEAR_APP_USER_DATA), so is
# `dpm remove-active-admin` ("non-test admin"), so is `pm uninstall`
# (DELETE_FAILED_DEVICE_POLICY_MANAGER), and factory reset is blocked by our own restriction.
#
# `adb install -r` is NOT shut: setUninstallBlocked blocks uninstall, not update. So a newer
# APK goes on over the top, and the app does for itself what the shell may not.
if [ -n "$RELEASE" ]; then
    [ -n "$TOKEN" ] || { echo "RELEASE=1 needs the phone's own token: RELEASE=1 TOKEN=<token> $0"; exit 2; }
    for S in $SERIALS; do
        printf '  ·  %s  releasing  ' "$S"
        adb -s "$S" install -r "$APK" >/dev/null 2>&1 || { echo "FAILED at install"; continue; }
        # --include-stopped-packages IS NOT OPTIONAL: install -r leaves the app STOPPED, and a
        # stopped app hears no broadcast. Without it, result=0 and nothing happens.
        OUT=$(adb -s "$S" shell am broadcast --include-stopped-packages \
                  -a "$PKG.RELEASE" -n "$PKG/.ReleaseReceiver" \
                  -e token "$TOKEN" 2>&1)
        if printf '%s' "$OUT" | grep -q 'TOKEN MISMATCH'; then
            echo "WRONG TOKEN — nothing was changed. Check this phone's register row."
        elif printf '%s' "$OUT" | grep -q 'PARTIAL'; then
            # Not a failure: unlocked and holding no token, which is the state a fresh enrol is
            # accepted in. Something else still owns it -- on Watu stock, usually Knox Guard.
            echo "PARTIAL — unlocked and token cleared, but another admin still owns it."
            echo "           Re-enrol and re-lock it as it is. Run: adb shell dumpsys device_policy"
        elif printf '%s' "$OUT" | grep -q 'RELEASED'; then
            echo "RELEASED — ordinary phone again."
        else
            echo "FAILED — $(printf '%s' "$OUT" | sed -n 's/.*data="\([^"]*\)".*/\1/p')"
        fi
    done
    exit 0
fi

# THE ONE CASE WHERE THE IMEI MATCH IS SKIPPED, because it protects against nothing: one
# phone, one token. There is no other handset to confuse it with, so the pairing cannot be
# wrong -- and skipping it also skips the "could not read this phone's IMEI" failure, which
# is what stops a single-phone job dead on Android 10+ where the modem read is refused.
SINGLE="$TOKEN"
if [ -z "$SINGLE" ] && [ "$N_PHONES" = "1" ] && [ "${#TOKEN_OF[@]}" = "1" ]; then
    for v in "${TOKEN_OF[@]}"; do SINGLE="$v"; done
    echo "One phone, one token: pairing them directly (no IMEI match needed)."
fi
echo

ok=0; skipped=0; failed=0
UNMATCHED=""

for S in $SERIALS; do
    # The handset's own idea of its IMEI. Empty on a phone that has not been provisioned yet
    # and whose build refuses the read -- that is ordinary, not a fault; see Imei.java.
    IMEI=$(adb -s "$S" shell service call iphonesubinfo 1 2>/dev/null \
           | sed -n 's/.*'"'"'\(.*\)'"'"'.*/\1/p' | tr -cd '0-9' | tail -c 16)
    if [ -n "$SINGLE" ]; then TOK="$SINGLE"; else TOK="${TOKEN_OF[$IMEI]:-}"; fi

    if [ -z "$TOK" ]; then
        # NEVER GUESS. A token written into the wrong handset makes that phone answer for
        # another customer's loan, and the only way back is a factory reset.
        echo "  ?  $S — could not match an IMEI (read: '${IMEI:-none}'). Left for the manual pass."
        UNMATCHED="$UNMATCHED $S"
        skipped=$((skipped+1))
        continue
    fi

    printf '  ·  %s  imei %s  ' "$S" "${IMEI:-(not read)}"

    adb -s "$S" install -r "$APK" >/dev/null 2>&1 || {
        echo "FAILED at install"; failed=$((failed+1)); continue; }

    # Order is not optional: owner first, THEN the token. The other way round the receiver
    # drops the token and adb still prints a success line. That cost an evening once.
    # "already set" is not a failure -- it is the ordinary state of every phone being redone,
    # and it arrives as a red Java stack trace, which is not how a success usually looks.
    OWNER=$(adb -s "$S" shell dpm set-device-owner "$ADMIN" 2>&1)
    if ! printf '%s' "$OWNER" | grep -qiE 'success|already set|already an admin'; then
        echo "FAILED at set-device-owner — phone must have NO google account and NO screen lock"
        failed=$((failed+1)); continue
    fi

    # EnrolReceiver answers with a result code and a readable message, so a refusal says why
    # rather than printing result=0 and meaning nothing.
    # --include-stopped-packages IS NOT OPTIONAL. See the note at the top of this file.
    # WAS is what lets a handset move onto a different token: the receiver takes a second one
    # from anybody who can name the first, which only the office can.
    OUT=$(adb -s "$S" shell am broadcast --include-stopped-packages \
              -a "$PKG.ENROL" -n "$PKG/.EnrolReceiver" \
              -e server "$SERVER" -e token "$TOK" ${WAS:+-e current "$WAS"} 2>&1)
    if printf '%s' "$OUT" | grep -q 'ALREADY ENROLLED'; then
        echo "ALREADY ENROLLED under another token (add WAS=<the token it holds now>)"
        ok=$((ok+1))
    elif printf '%s' "$OUT" | grep -q 'ENROLLED'; then
        echo "ENROLLED"
        ok=$((ok+1))
    else
        echo "FAILED — $(printf '%s' "$OUT" | sed -n 's/.*data="\([^"]*\)".*/\1/p')"
        failed=$((failed+1))
    fi
done

echo
echo "enrolled $ok · failed $failed · unmatched $skipped"

if [ -n "$UNMATCHED" ]; then
    cat <<EOF

THE UNMATCHED ONES, one at a time. Read the IMEI off the box, then:

    adb -s <serial> install -r $APK
    adb -s <serial> shell dpm set-device-owner $ADMIN
    adb -s <serial> shell am broadcast --include-stopped-packages -a $PKG.ENROL \\
        -n $PKG/.EnrolReceiver -e server $SERVER -e token <that phone's token>

Serials waiting:$UNMATCHED
EOF
fi

cat <<'EOF'

NOW LOCK THEM BEFORE THEY GO BACK IN THE BOX. Enrolling a phone does not lock it, and an
order to lock only reaches a handset that is ONLINE -- a boxed phone with no SIM never hears
it. So while these are still on the bench:

    Portal -> Devices -> tick them -> Funga -> reason ("stock, unsold")
    Wait for the register to read CONFIRMED, not pending.
    Only then power them off and box them.

From that moment each phone carries its own lock: it comes back up locked with no network at
all, through as many reboots as anyone tries, and cannot be factory reset out of it.
EOF
