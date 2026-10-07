Add-Type -AssemblyName System.Drawing
$path = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\.user_uploaded\media_1791233020633.png'
$src = [System.Drawing.Image]::FromFile($path)

# Crop the search bar of Odoo
$x = [int]($src.Width * 0.40)
$y = [int]($src.Height * 0.28)
$w = [int]($src.Width * 0.28)
$h = [int]($src.Height * 0.04)

$rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
$bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

$outPath = 'C:\Users\Scando-PC\.gemini\antigravity-ide\brain\994f614f-65c9-4434-9c79-7ab15812e497\scratch\odoo_search_bar.png'
$bmp.Save($outPath)
$bmp.Dispose()
$src.Dispose()
Write-Output "Search bar saved"
