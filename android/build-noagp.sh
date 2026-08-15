#!/bin/bash
# =====================================================================================
# Build HOOP Calls WITHOUT Gradle/AGP -- aapt2 + javac + d8 + zipalign + apksigner.
# Exists because this build environment can reach dl.google.com's SDK repository but not
# its Maven CDN, so the Android Gradle Plugin cannot be resolved. The wrapper uses only
# platform APIs (androidx was removed with the browser-update change), so the platform
# toolchain is enough. Usage:  ANDROID_HOME=/opt/android-sdk ./build-noagp.sh [startUrl]
# =====================================================================================
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
BT="$SDK/build-tools/35.0.0"
PLAT="$SDK/platforms/android-35/android.jar"
START_URL="${1:-https://hoop-pmo.vercel.app/call}"
VC=$(python3 -c "import json;print(json.load(open('../app-version.json'))['versionCode'])")
VN=$(python3 -c "import json;print(json.load(open('../app-version.json'))['versionName'])")
OUT=build-noagp; rm -rf $OUT; mkdir -p $OUT/gen/com/samaritantechs/hoopcalls $OUT/classes $OUT/dex

cat > $OUT/gen/com/samaritantechs/hoopcalls/BuildConfig.java <<EOJ
package com.samaritantechs.hoopcalls;
public final class BuildConfig {
  public static final boolean DEBUG = false;
  public static final String APPLICATION_ID = "com.samaritantechs.hoopcalls";
  public static final int VERSION_CODE = $VC;
  public static final String VERSION_NAME = "$VN";
  public static final String START_URL = "$START_URL";
}
EOJ

"$BT/aapt2" compile --dir app/src/main/res -o $OUT/res.zip
"$BT/aapt2" link -o $OUT/base.apk -I "$PLAT" \
  --manifest app/src/main/AndroidManifest.xml \
  --min-sdk-version 23 --target-sdk-version 35 \
  --version-code "$VC" --version-name "$VN" \
  --java $OUT/gen $OUT/res.zip --auto-add-overlay

javac -source 1.8 -target 1.8 -nowarn -bootclasspath "$PLAT" -d $OUT/classes \
  $OUT/gen/com/samaritantechs/hoopcalls/*.java app/src/main/java/com/samaritantechs/hoopcalls/*.java

find $OUT/classes -name '*.class' > $OUT/classlist.txt
"$BT/d8" --release --lib "$PLAT" --min-api 23 --output $OUT/dex $(cat $OUT/classlist.txt)

cp $OUT/base.apk $OUT/unsigned.apk
(cd $OUT/dex && zip -q -X ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 $OUT/unsigned.apk $OUT/aligned.apk
"$BT/apksigner" sign --ks sideload.keystore --ks-key-alias hopecalls \
  --ks-pass pass:hopecalls --key-pass pass:hopecalls \
  --out $OUT/HOOP-Calls.apk $OUT/aligned.apk
"$BT/apksigner" verify $OUT/HOOP-Calls.apk
ls -la $OUT/HOOP-Calls.apk
echo "BUILD OK -> $OUT/HOOP-Calls.apk (startUrl=$START_URL, v$VN code $VC)"
