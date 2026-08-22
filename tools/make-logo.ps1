# Renders the two extension-list logos: the published one and the dev build's inverted twin.
#
# 256x256 RGBA PNG, which is the size and format Dynamic Fog's working manifest uses and the one the
# sibling project confirmed renders in Owlbear's extensions list. Structured like the sibling's logo
# too — a bordered plate with the action glyph centred on it — so the two extensions read as a pair.
Add-Type -AssemblyName System.Drawing

function New-Logo {
    param(
        [string] $Path,
        [string] $BorderHex,
        [string] $PlateHex,
        [string] $InkHex
    )

    $size = 256
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $border = [System.Drawing.ColorTranslator]::FromHtml($BorderHex)
    $plate = [System.Drawing.ColorTranslator]::FromHtml($PlateHex)
    $ink = [System.Drawing.ColorTranslator]::FromHtml($InkHex)

    function Rounded([double] $x, [double] $y, [double] $w, [double] $h, [double] $r) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $d = $r * 2
        $p.AddArc($x, $y, $d, $d, 180, 90)
        $p.AddArc(($x + $w - $d), $y, $d, $d, 270, 90)
        $p.AddArc(($x + $w - $d), ($y + $h - $d), $d, $d, 0, 90)
        $p.AddArc($x, ($y + $h - $d), $d, $d, 90, 90)
        $p.CloseFigure()
        $p
    }

    $g.Clear([System.Drawing.Color]::Transparent)
    $outer = Rounded 0 0 $size $size 40
    $inner = Rounded 14 14 ($size - 28) ($size - 28) 30
    $borderBrush = New-Object System.Drawing.SolidBrush($border)
    $plateBrush = New-Object System.Drawing.SolidBrush($plate)
    $g.FillPath($borderBrush, $outer)
    $g.FillPath($plateBrush, $inner)

    # The glyph is authored in the action icon's 24-unit box. Scaled into the plate and nudged so its
    # drawn extents sit centred rather than its nominal box, which they are not the same thing.
    $scale = 6.6
    $offset = ($size - 24 * $scale) / 2
    $shiftX = -0.85
    $shiftY = 0.85

    function P([double] $x, [double] $y) {
        New-Object System.Drawing.PointF(($offset + ($x + $shiftX) * $scale), ($offset + ($y + $shiftY) * $scale))
    }

    $pen = New-Object System.Drawing.Pen($ink, (1.6 * $scale))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # The room's corner traced out of the map: down the left wall, along the top, and the floor run.
    $g.DrawLines($pen, @((P 4 20), (P 4 6.5), (P 15 6.5)))
    $g.DrawLines($pen, @((P 4 20), (P 14 20)))

    # The dashed lead to the vertex being nudged off the corner. GDI+ dash lengths are multiples of
    # the pen width, so the SVG's "1 2.4" user units divide through by the 1.6 stroke.
    $dashed = $pen.Clone()
    $dashed.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Custom
    $dashed.DashPattern = @(0.625, 1.5)
    $dashed.StartCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $dashed.EndCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $g.DrawLine($dashed, (P 17.5 6.5), (P 20 4))

    # Filled with the plate colour before stroking. The SVG leaves it unfilled, which is invisible at
    # 24px because the stroke nearly closes the hole — but scaled up, the dashed lead running to the
    # centre shows through the ring and reads as a slash across it.
    $r = 1.7
    $c = P 20 4
    $g.FillEllipse($plateBrush, ($c.X - $r * $scale), ($c.Y - $r * $scale), (2 * $r * $scale), (2 * $r * $scale))
    $g.DrawEllipse($pen, ($c.X - $r * $scale), ($c.Y - $r * $scale), (2 * $r * $scale), (2 * $r * $scale))

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    foreach ($d in @($dashed, $pen, $borderBrush, $plateBrush, $outer, $inner, $g, $bmp)) { $d.Dispose() }
    "wrote $Path"
}

# Writes straight into public/. Run it from anywhere:
#   powershell -File tools/make-logo.ps1
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "public"

# Published: ink on parchment, matching the landing page and the sibling extension.
New-Logo -Path (Join-Path $out "logo.png") -BorderHex "#d9c7a7" -PlateHex "#f4ecd8" -InkHex "#4a3728"

# Dev: ground and linework swap.
#
# Inverted rather than carrying a corner badge, and that is the sibling's finding rather than a
# preference. A badged dot rendered correctly in Owlbear's add dialog and came out unbadged in the
# extensions list, so the list applies some mask, crop or downscale of its own. An inversion has no
# corner to lose — it survives whatever the list does to it.
New-Logo -Path (Join-Path $out "logo-dev.png") -BorderHex "#2f241a" -PlateHex "#4a3728" -InkHex "#f4ecd8"
