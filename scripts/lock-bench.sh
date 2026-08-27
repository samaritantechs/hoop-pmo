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

TOKENS="${1:-}"
if [ -z "$TOKENS" ] || [ ! -f "$TOKENS" ]; then
    echo "usage: $0 <token-list.txt>    (one 'IMEI token' per line, from Devices -> Sajili simu)"
    exit 2
fi
[ -f "$APK" ] || { echo "APK not found: $APK   (set APK=/path/to/HOOPLOAN-Lock.apk)"; exit 2; }

# IMEI -> token. Tolerates commas, tabs, blank lines and # comments, because this file is
# pasted together by hand at six in the morning.
declare -A TOKEN_OF
while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr ',\t' '  ')"
    set -- $line
    [ $# -ge 2 ] || continue
    TOKEN_OF["$1"]="$2"
done < "$TOKENS"
echo "Loaded ${#TOKEN_OF[@]} tokens from $TOKENS"

SERIALS=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
[ -n "$SERIALS" ] || { echo "No phones ready. Check the cable, and that 'Allow USB debugging' was accepted."; exit 1; }
echo "Phones connected: $(printf '%s\n' "$SERIALS" | wc -l | tr -d ' ')"
echo

ok=0; skipped=0; failed=0
UNMATCHED=""

for S in $SERIALS; do
    # The handset's own idea of its IMEI. Empty on a phone that has not been provisioned yet
    # and whose build refuses the read -- that is ordinary, not a fault; see Imei.java.
    IMEI=$(adb -s "$S" shell service call iphonesubinfo 1 2>/dev/null \
           | sed -n 's/.*'"'"'\(.*\)'"'"'.*/\1/p' | tr -cd '0-9' | tail -c 16)
    TOKEN="${TOKEN_OF[$IMEI]:-}"

    if [ -z "$TOKEN" ]; then
        # NEVER GUESS. A token written into the wrong handset makes that phone answer for
        # another customer's loan, and the only way back is a factory reset.
        echo "  ?  $S — could not match an IMEI (read: '${IMEI:-none}'). Left for the manual pass."
        UNMATCHED="$UNMATCHED $S"
        skipped=$((skipped+1))
        continue
    fi

    printf '  ·  %s  imei %s  ' "$S" "$IMEI"

    adb -s "$S" install -r "$APK" >/dev/null 2>&1 || {
        echo "FAILED at install"; failed=$((failed+1)); continue; }

    # Order is not optional: owner first, THEN the token. The other way round the receiver
    # drops the token and adb still prints a success line. That cost an evening once.
    if ! adb -s "$S" shell dpm set-device-owner "$ADMIN" 2>&1 | grep -qi 'success'; then
        echo "FAILED at set-device-owner — phone must have NO google account and NO screen lock"
        failed=$((failed+1)); continue
    fi

    # EnrolReceiver answers with a result code and a readable message, so a refusal says why
    # rather than printing result=0 and meaning nothing.
    OUT=$(adb -s "$S" shell am broadcast -a "$PKG.ENROL" -n "$PKG/.EnrolReceiver" \
              -e server "$SERVER" -e token "$TOKEN" 2>&1)
    if printf '%s' "$OUT" | grep -q 'ENROLLED'; then
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
    adb -s <serial> shell am broadcast -a $PKG.ENROL \\
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
