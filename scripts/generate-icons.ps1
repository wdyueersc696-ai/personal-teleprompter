param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\icons')
)

Add-Type -AssemblyName System.Drawing

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

function New-TeleprompterIcon {
    param(
        [int]$Size,
        [string]$Filename,
        [bool]$Maskable
    )

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#0B0D12'))

    $center = $Size / 2.0
    $safeInset = if ($Maskable) { $Size * 0.22 } else { $Size * 0.14 }
    $gap = $Size * 0.09
    $lineWidth = [Math]::Max(3.0, $Size * 0.024)
    $dotRadius = $Size * 0.052
    $haloRadius = $Size * 0.102

    $lineColor = [System.Drawing.Color]::FromArgb(132, 244, 241, 234)
    $haloColor = [System.Drawing.Color]::FromArgb(46, 255, 177, 90)
    $tallyColor = [System.Drawing.ColorTranslator]::FromHtml('#FFB15A')
    $linePen = [System.Drawing.Pen]::new($lineColor, $lineWidth)
    $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $haloPen = [System.Drawing.Pen]::new($haloColor, $lineWidth)
    $dotBrush = [System.Drawing.SolidBrush]::new($tallyColor)

    $graphics.DrawLine($linePen, $safeInset, $center, $center - $gap, $center)
    $graphics.DrawLine($linePen, $center + $gap, $center, $Size - $safeInset, $center)
    $graphics.DrawEllipse($haloPen, $center - $haloRadius, $center - $haloRadius, $haloRadius * 2, $haloRadius * 2)
    $graphics.FillEllipse($dotBrush, $center - $dotRadius, $center - $dotRadius, $dotRadius * 2, $dotRadius * 2)

    $target = Join-Path $resolvedOutput $Filename
    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)

    $dotBrush.Dispose()
    $haloPen.Dispose()
    $linePen.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

New-TeleprompterIcon -Size 180 -Filename 'icon-180.png' -Maskable $false
New-TeleprompterIcon -Size 192 -Filename 'icon-192.png' -Maskable $false
New-TeleprompterIcon -Size 512 -Filename 'icon-512.png' -Maskable $false
New-TeleprompterIcon -Size 512 -Filename 'icon-maskable-512.png' -Maskable $true

Write-Output "Icons generated in $resolvedOutput"
