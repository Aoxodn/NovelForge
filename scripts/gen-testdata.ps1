# Build a sample DOCX (10 chapters, centered+bold titles) from the sample TXT.
# The script file is ASCII-only; Chinese data comes from the UTF-8 TXT at runtime.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$dataDir = Join-Path $PSScriptRoot "testdata"
$txtFile = Get-ChildItem -LiteralPath $dataDir -Filter "*.txt" | Select-Object -First 1
if ($null -eq $txtFile) { Write-Error "no txt found in $dataDir"; exit 1 }
$txtPath = $txtFile.FullName

$chapterMark = [char]0x7b2c   # first char of the Chinese word for "chapter N" headings

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')
[void]$sb.Append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>')

$chapterCount = 0
foreach ($line in (Get-Content -LiteralPath $txtPath -Encoding UTF8)) {
    $t = $line.Trim()
    if ($t.Length -eq 0) { continue }
    if ($t[0] -eq $chapterMark) {
        # title paragraph: centered + bold + 16pt (w:sz = 32 half-points)
        [void]$sb.Append('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">')
        [void]$sb.Append([System.Security.SecurityElement]::Escape($t))
        [void]$sb.Append('</w:t></w:r></w:p>')
        $chapterCount++
    } else {
        [void]$sb.Append('<w:p><w:r><w:t xml:space="preserve">')
        [void]$sb.Append([System.Security.SecurityElement]::Escape($t))
        [void]$sb.Append('</w:t></w:r></w:p>')
    }
}
[void]$sb.Append('</w:body></w:document>')

$outPath = Join-Path $PSScriptRoot "testdata\sample-novel.docx"
if (Test-Path -LiteralPath $outPath) { Remove-Item -LiteralPath $outPath -Force }

$zip = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Create)
$entry = $zip.CreateEntry("word/document.xml")
$sw = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
$sw.Write($sb.ToString())
$sw.Dispose()
$zip.Dispose()

Write-Output "DOCX created: $outPath (chapters detected while building: $chapterCount)"
