# Generate NovelForge app icon source PNG (1024x1024)
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 34, 40, 54),
    [System.Drawing.Color]::FromArgb(255, 52, 62, 86),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillRectangle($brush, $rect)

$gold = [System.Drawing.Color]::FromArgb(255, 232, 163, 61)
$goldBrush = New-Object System.Drawing.SolidBrush($gold)
$g.FillRectangle($goldBrush, 96, 208, 832, 20)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font("Microsoft YaHei", 380, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF(0, 40, $size, $size)
$g.DrawString([char]0x6587, $font, $white, $textRect, $fmt)

$g.FillRectangle($goldBrush, 96, 796, 832, 20)

$g.Dispose()
$out = Join-Path $PSScriptRoot "app-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon saved: $out"
