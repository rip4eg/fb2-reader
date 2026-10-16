# Прогон всех тестов читалки.
# Требуется Node.js; для двух последних наборов — пакеты jsdom и fake-indexeddb
# (npm install --no-save jsdom fake-indexeddb).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($t in @('node-tests.mjs', 'store-tests.mjs', 'smoke-tests.mjs')) {
  Write-Host "`n=== $t ===" -ForegroundColor Cyan
  & node (Join-Path $here $t)
  if ($LASTEXITCODE -ne 0) { Write-Host "ПРОВАЛ: $t" -ForegroundColor Red; exit 1 }
}
Write-Host "`nВсе наборы тестов пройдены." -ForegroundColor Green
