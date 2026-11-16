#!/usr/bin/env bash
# 手工打包 APK（不用 Gradle）：aapt2 → javac → d8 → 打包 → zipalign → apksigner
#
#   bash android/probe/build.sh && bash android/probe/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TC="$ROOT/.toolchain"

JDK="$(ls -d "$TC"/jdk-17* 2>/dev/null | head -1)"
BT="$TC/android-14"
ANDROID_JAR="$TC/android-10/android.jar"

[ -n "$JDK" ] || { echo "缺少 JDK"; exit 1; }
[ -f "$ANDROID_JAR" ] || { echo "缺少 android.jar"; exit 1; }
[ -x "$BT/aapt2.exe" ] || { echo "缺少 aapt2"; exit 1; }

BUILD="$HERE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/gen" "$BUILD/dex" "$BUILD/apk"

echo "— aapt2 compile"
"$BT/aapt2.exe" compile --dir "$HERE/res" -o "$BUILD/res.zip"
mkdir -p "$BUILD/resdir"
(cd "$BUILD/resdir" && /c/Windows/System32/tar.exe -xf "$BUILD/res.zip")

echo "— aapt2 link"
"$BT/aapt2.exe" link \
  -o "$BUILD/apk/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  $(find "$BUILD/resdir" -name "*.flat" | tr "\n" " ") \
  --java "$BUILD/gen" \
  --min-sdk-version 29 --target-sdk-version 29

echo "— javac"
JAVAC_OUT=$("$JDK/bin/javac" \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -encoding UTF-8 \
  -d "$BUILD/classes" \
  $(find "$HERE/src" -name '*.java') \
  "$BUILD/gen/mimic/probe/R.java" 2>&1) || { echo "$JAVAC_OUT"; echo "javac 失败"; exit 1; }
echo "$JAVAC_OUT" | grep -v "bootstrap class path\|obsolete\|warning: \[options\]" || true

echo "— d8"
"$JDK/bin/java" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --min-api 29 --lib "$ANDROID_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

echo "— 打包 classes.dex"
cp "$BUILD/apk/base.apk" "$BUILD/apk/unsigned.apk"
"$JDK/bin/jar" uf "$BUILD/apk/unsigned.apk" -C "$BUILD/dex" classes.dex

echo "— zipalign"
"$BT/zipalign.exe" -f 4 "$BUILD/apk/unsigned.apk" "$BUILD/apk/aligned.apk"

echo "— 签名（首次运行会生成 debug keystore）"
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  "$JDK/bin/keytool" -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias mimic -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Mimic Probe, OU=Dev, O=Mimic, L=CN, ST=CN, C=CN" >/dev/null 2>&1
  echo "  已生成 $KS"
fi
JAVA_HOME="$JDK" "$BT/apksigner.bat" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$HERE/mimic-probe.apk" "$BUILD/apk/aligned.apk"

echo
ls -la "$HERE/mimic-probe.apk"
echo "ok: $HERE/mimic-probe.apk"