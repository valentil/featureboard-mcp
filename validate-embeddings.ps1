# FeatureBoard hybrid-RAG (FBMCPF-315) — one-shot embeddings validation.
# Installs the optional embedding dependency, runs the double-gated real-model
# test, and drops a timestamped log in .\validation-logs\ for Claude to read.
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$logDir = Join-Path $PSScriptRoot 'validation-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$log    = Join-Path $logDir "embeddings-$stamp.log"

function Emit([string]$m) { $m | Tee-Object -FilePath $log -Append }

Emit "=== FeatureBoard hybrid-RAG embeddings validation (FBMCPF-315) ==="
Emit "started : $(Get-Date -Format o)"
Emit "repo    : $PSScriptRoot"
Emit "node    : $(node -v 2>&1)"
Emit "npm     : $(npm -v 2>&1)"
Emit ""

Emit "--- step 1/2: npm install (pulls optional @xenova/transformers) ---"
npm install 2>&1 | Tee-Object -FilePath $log -Append
$npmExit = $LASTEXITCODE
Emit "npm install exit code: $npmExit"
Emit ""

Emit "--- step 2/2: node --test test/vector_rag.test.js (first run downloads ~25MB model) ---"
$env:FEATUREBOARD_TEST_EMBEDDINGS = '1'
node --test test/vector_rag.test.js 2>&1 | Tee-Object -FilePath $log -Append
$testExit = $LASTEXITCODE
Emit "test exit code: $testExit"
Emit ""

if ($npmExit -eq 0 -and $testExit -eq 0) {
  Emit "RESULT: PASS - hybrid embeddings path validated live."
} else {
  Emit "RESULT: FAIL - npmExit=$npmExit testExit=$testExit (see output above)."
}
Emit "finished: $(Get-Date -Format o)"

Copy-Item -Path $log -Destination (Join-Path $logDir 'LATEST.log') -Force
Emit ""
Emit "Log saved to : $log"
Emit "Also copied to: $(Join-Path $logDir 'LATEST.log')"

Write-Host ""
Write-Host "Done. Tell Claude to check validation-logs\LATEST.log" -ForegroundColor Green
