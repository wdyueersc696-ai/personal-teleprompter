param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\icons')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase

$icons = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($icons) | Out-Null
$source = [xml](Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\icons\icon-source.svg') -Encoding UTF8 -Raw)
$names = [Xml.XmlNamespaceManager]::new($source.NameTable)
$names.AddNamespace('svg', 'http://www.w3.org/2000/svg')
$background = $source.SelectSingleNode('/svg:svg/svg:rect', $names)
$silhouette = $source.SelectNodes('/svg:svg/svg:g[@id="cat"]/svg:path', $names)
$extent = [double]($source.DocumentElement.GetAttribute('viewBox').Split(' ')[2])

function Get-Brush([string]$Fill) {
    [Windows.Media.SolidColorBrush]::new([Windows.Media.ColorConverter]::ConvertFromString($Fill))
}

function Export-Icon([int]$Size, [string]$Name, [double]$MarkScale = 1) {
    $visual = [Windows.Media.DrawingVisual]::new()
    $drawing = $visual.RenderOpen()
    $drawing.DrawRectangle((Get-Brush $background.GetAttribute('fill')), $null, [Windows.Rect]::new(0, 0, $Size, $Size))
    $unit = $Size / $extent * $MarkScale
    $inset = $Size * (1 - $MarkScale) / 2
    $drawing.PushTransform([Windows.Media.MatrixTransform]::new($unit, 0, 0, $unit, $inset, $inset))
    foreach ($part in $silhouette) {
        $drawing.DrawGeometry((Get-Brush $part.GetAttribute('fill')), $null, [Windows.Media.Geometry]::Parse($part.GetAttribute('d')))
    }
    $drawing.Pop()
    $drawing.Close()

    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new($Size, $Size, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $file = [IO.File]::Create((Join-Path $icons $Name))
    try { $encoder.Save($file) } finally { $file.Dispose() }
}

Export-Icon 180 'icon-180.png'
Export-Icon 192 'icon-192.png'
Export-Icon 512 'icon-512.png'
# Keep the ears and tail inside the centered 80% mask-safe circle.
Export-Icon 512 'icon-maskable-512.png' 0.78
