Add-Type -AssemblyName System.Drawing
$path = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\.user_uploaded\media_1791233940212.png'
$src = [System.Drawing.Image]::FromFile($path)

[int]$scale = 2
[int]$x = [int]($src.Width * 0.40)
[int]$y = [int]($src.Height * 0.52)
[int]$w = [int]($src.Width * 0.33)
[int]$h = [int]($src.Height * 0.45)
[int]$sw = $w * $scale
[int]$sh = $h * $scale

$rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
$bmp = New-Object System.Drawing.Bitmap($sw, $sh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$destRect = New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)
$g.DrawImage($src, $destRect, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$bmp.Save('C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\scratch\odoo_reps_upscaled.png')
$bmp.Dispose()

[int]$x2 = [int]($src.Width * 0.40)
[int]$y2 = [int]($src.Height * 0.20)
[int]$w2 = [int]($src.Width * 0.33)
[int]$h2 = [int]($src.Height * 0.30)
[int]$sw2 = $w2 * $scale
[int]$sh2 = $h2 * $scale

$rect2 = New-Object System.Drawing.Rectangle($x2, $y2, $w2, $h2)
$bmp2 = New-Object System.Drawing.Bitmap($sw2, $sh2)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$destRect2 = New-Object System.Drawing.Rectangle(0, 0, $sw2, $sh2)
$g2.DrawImage($src, $destRect2, $rect2, [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()

$bmp2.Save('C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\scratch\dash_reps_upscaled.png')
$bmp2.Dispose()

$src.Dispose()
Write-Output "Done upscaling successfully"
