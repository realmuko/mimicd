param(
  [Parameter(Mandatory=$true)][string]$Png,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [double]$Scale = 2.0
)
# Windows 自带 OCR（Windows.Media.Ocr），不依赖 Python / 云 API。
# 输出一行 JSON：{"lines":[{"text":"...","x":..,"y":..,"w":..,"h":..}, ...]}
# 坐标已从「放大图」换算回原图像素。
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null

$img = [System.Drawing.Image]::FromFile($Png)
try {
  if ($W -le 0) { $W = $img.Width - $X }
  if ($H -le 0) { $H = $img.Height - $Y }
  $cropX = [Math]::Max(0, $X)
  $cropY = [Math]::Max(0, $Y)
  $cropW = [Math]::Min($W, $img.Width - $cropX)
  $cropH = [Math]::Min($H, $img.Height - $cropY)
  if ($cropW -le 0 -or $cropH -le 0) { throw "empty crop" }

  $bmp = New-Object System.Drawing.Bitmap ([int]($cropW * $Scale)), ([int]($cropH * $Scale))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $dst = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
  $src = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropW, $cropH
  $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()

  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "mimic-ocr-" + [guid]::NewGuid().ToString('N') + ".png")
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} finally {
  $img.Dispose()
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $lang = New-Object Windows.Globalization.Language "zh-Hans-CN"
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  }
  if (-not $engine) { throw "no OCR engine available" }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($l in $result.Lines) {
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = -1.0; $maxY = -1.0
    foreach ($word in $l.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      $right = $r.X + $r.Width
      $bottom = $r.Y + $r.Height
      if ($right -gt $maxX) { $maxX = $right }
      if ($bottom -gt $maxY) { $maxY = $bottom }
    }
    if ($maxX -lt 0) { continue }
    # 放大图坐标 → 原图坐标
    $ox = [Math]::Round($cropX + $minX / $Scale)
    $oy = [Math]::Round($cropY + $minY / $Scale)
    $ow = [Math]::Round(($maxX - $minX) / $Scale)
    $oh = [Math]::Round(($maxY - $minY) / $Scale)
    $lines += [ordered]@{ text = $l.Text; x = $ox; y = $oy; w = $ow; h = $oh }
  }
  $out = [ordered]@{ lines = $lines; scale = $Scale; crop = [ordered]@{ x = $cropX; y = $cropY; w = $cropW; h = $cropH } }
  $out | ConvertTo-Json -Depth 6 -Compress
} finally {
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
}