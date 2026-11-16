#!/usr/bin/env bash
# 一次性装好注入器需要的工具链（约 330 MB，装在 .toolchain/，不入库）。
#
#   bash android/injector/setup-toolchain.sh
#
# 下载走国内镜像：清华的 Adoptium 镜像（JDK 17，实测 190 MB / 2.7 秒），
# build-tools 与 platform 走 dl.google.com（实测 58 MB / 0.7 秒）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TC="$ROOT/.toolchain"
mkdir -p "$TC"
cd "$TC"

TAR=/c/Windows/System32/tar.exe
[ -x "$TAR" ] || TAR=tar

fetch() {
  local url="$1" out="$2"
  if [ -s "$out" ]; then
    echo "已有 $out，跳过下载"
    return
  fi
  echo "下载 $out"
  curl -L --retry 3 --max-time 900 -o "$out" "$url" -sS -w "  %{http_code} %{size_download} bytes in %{time_total}s\n"
}

fetch "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/OpenJDK17U-jdk_x64_windows_hotspot_17.0.21_9.zip" "jdk17.zip"
fetch "https://dl.google.com/android/repository/build-tools_r34-windows.zip" "build-tools-r34.zip"
fetch "https://dl.google.com/android/repository/platform-29_r05.zip" "platform-29.zip"

for z in jdk17.zip build-tools-r34.zip platform-29.zip; do
  echo "解压 $z"
  "$TAR" -xf "$z"
done

echo
echo "完成："
ls -d "$TC"/jdk-* "$TC"/android-* 2>/dev/null
echo "现在可以：bash android/injector/build.sh"