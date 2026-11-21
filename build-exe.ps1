# Builds BankPositionPortal.exe — a single-file offline executable via esbuild + Node SEA.
# Front-end (public/) and parser runtime assets ship as loose files next to the exe so the
# app can be tweaked without a full rebuild, mirroring the Payroll_HC build.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

Write-Host "1/6 Cleaning build/ and dist/..."
Remove-Item -Recurse -Force "$root\build","$root\dist" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$root\build","$root\dist" | Out-Null

Write-Host "2/6 Bundling server.js with esbuild..."
& npx esbuild server.js --bundle --platform=node --target=node20 --format=cjs `
  --outfile=build/bundle.js `
  --external:pdfjs-dist --external:exceljs --external:cheerio --external:bcryptjs --external:tesseract.js
if ($LASTEXITCODE -ne 0) { throw "esbuild failed" }

Write-Host "3/6 Generating SEA blob..."
& node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw "SEA blob generation failed" }

Write-Host "4/6 Copying node.exe and injecting blob..."
Copy-Item (Get-Command node).Source "dist\BankPositionPortal.exe" -Force
& npx postject "dist\BankPositionPortal.exe" NODE_SEA_BLOB "build\sea-prep.blob" `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject failed" }

Write-Host "5/6 Copying front-end + runtime deps next to the exe..."
Copy-Item -Recurse -Force "$root\public" "dist\public"
Copy-Item -Recurse -Force "$root\ocr-assets" "dist\ocr-assets"
Copy-Item -Recurse -Force "$root\outlook-agent" "dist\outlook-agent"
Copy-Item -Force "$root\Install Outlook Agent.cmd","$root\Remove Outlook Agent.cmd" "dist\"
New-Item -ItemType Directory -Force "dist\node_modules" | Out-Null
# runtime deps kept external from the SEA bundle (native-ish / asset-loading libs)
$mods = @("pdfjs-dist","exceljs","cheerio","bcryptjs","multer","express","express-session",
          "tesseract.js","tesseract.js-core","jimp","node-fetch","bmp-js","idb-keyval","is-electron","wasm-feature-detect","zlibjs")
foreach ($m in $mods) {
  if (Test-Path "$root\node_modules\$m") {
    robocopy "$root\node_modules\$m" "dist\node_modules\$m" /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
}

Write-Host "6/6 Preparing data folders..."
New-Item -ItemType Directory -Force "dist\data","dist\storage\statements","dist\backups" | Out-Null

Write-Host ""
Write-Host "Done. Run dist\BankPositionPortal.exe  (default port 4201)."
Write-Host "Default login: 123 / 123  — change it in Settings after first run."
