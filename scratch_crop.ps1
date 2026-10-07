Add-Type -AssemblyName System.Drawing
$path = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\.user_uploaded\media_1791233940212.png'
$src = [System.Drawing.Image]::FromFile($path)
Write-Output ("Width: " + $src.Width + " Height: " + $src.Height)

# Crop the bottom Odoo table
$x = [int]($src.Width * 0.40)
$y = [int]($src.Height * 0.52)
$w = [int]($src.Width * 0.33)
$h = [int]($src.Height * 0.45)

$rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
$bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$outPath = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\scratch\odoo_reps_cropped.png'
$bmp.Save($outPath)
$bmp.Dispose()

# Also crop the top Dashboard table
$x2 = [int]($src.Width * 0.40)
$y2 = [int]($src.Height * 0.20)
$w2 = [int]($src.Width * 0.33)
$h2 = [int]($src.Height * 0.30)

$rect2 = New-Object System.Drawing.Rectangle($x2, $y2, $w2, $h2)
$bmp2 = New-Object System.Drawing.Bitmap($rect2.Width, $rect2.Height)
$g2 = [System.Drawing.Graphics]::FromImage($bmp2)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $rect2, [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()

$outPath2 = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\scratch\dash_reps_cropped.png'
$bmp2.Save($outPath2)
$bmp2.Dispose()

$src.Dispose()
Write-Output "Done cropping reps"
