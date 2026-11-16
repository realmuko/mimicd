#!/usr/bin/env bash
# 构建注入器 dex。这是全仓库唯一需要 JDK + Android build-tools 的部件。
#
#   bash android/injector/build.sh
#
# 依赖（都在 .toolchain/，不入库）：
#   .toolchain/jdk-17*/bin/javac        JDK 17
#   .toolchain/android-10/android.jar   API 29 的 android.jar
#   .toolchain/android-14/lib/d8.jar    d8（build-tools 34）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TC="$ROOT/.toolchain"

JDK="$(ls -d "$TC"/jdk-17* 2>/dev/null | head -1)"
ANDROID_JAR="$TC/android-10/android.jar"
D8_JAR="$(ls "$TC"/android-14/lib/d8.jar 2>/dev/null | head -1)"

[ -n "$JDK" ] || { echo "缺少 JDK：$TC/jdk-17*"; exit 1; }
[ -f "$ANDROID_JAR" ] || { echo "缺少 android.jar：$ANDROID_JAR"; exit 1; }
[ -f "$D8_JAR" ] || { echo "缺少 d8：$D8_JAR"; exit 1; }

BUILD="$HERE/build"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex"

echo "— javac"
"$JDK/bin/javac" \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -encoding UTF-8 \
  -d "$BUILD/classes" \
  "$HERE/src/mimic/Injector.java" 2>&1 | grep -v "bootstrap class path\|obsolete\|warning: \[options\]" || true

echo "— d8"
"$JDK/bin/java" -cp "$D8_JAR" com.android.tools.r8.D8 \
  --min-api 29 \
  --lib "$ANDROID_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

ls -la "$BUILD/dex"
echo "ok: $BUILD/dex/classes.dex"