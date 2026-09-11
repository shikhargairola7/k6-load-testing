# run.ps1 - load .env into the process environment, then run the k6 load test.
# k6 does not read .env files itself; it reads real environment variables (__ENV).
#
# Usage:
#   .\run.ps1                          # .env + load-test.js, defaults from .env
#   .\run.ps1 -e CYCLES_PER_USER=2     # any extra args are forwarded to `k6 run`
#   .\run.ps1 -e USERS=3
#   .\run.ps1 --out json=results/raw.json
#
# To use a different env file, set $env:ENV_FILE first:
#   $env:ENV_FILE = ".env.staging"; .\run.ps1
#
# Output files are named  <type>-<U>u-<C>c-<timestamp>.csv/json
#   U = users, C = cycles per user   e.g. requests-3u-100c-2026-09-10T19-16-32.csv

# k6 writes progress/info to stderr; don't let PowerShell treat that as fatal.
$ErrorActionPreference = "Continue"

$EnvFile = if ($env:ENV_FILE) { $env:ENV_FILE } else { ".env" }
$Script  = "load-test.js"
$Stamp   = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$ResultsDir = Join-Path (Get-Location).Path "results"

# k6 does not create output directories for handleSummary files.
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

if (Test-Path $EnvFile) {
  foreach ($raw in Get-Content $EnvFile) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $val, "Process")
  }
  Write-Host "Loaded environment from $EnvFile"
} else {
  Write-Host "No $EnvFile found - relying on already-set environment variables"
}

# Mirror any `-e KEY=VALUE` / `--env KEY=VALUE` args into the process environment
# (they are still forwarded to k6 too). This lets wrapper-side flags such as
# APPEND_SUMMARY_CSV and EMBED_REQUESTS_IN_JSON be overridden with -e like anything else.
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  $kv = $null
  if (($a -eq "-e" -or $a -eq "--env") -and ($i + 1) -lt $args.Count) { $kv = [string]$args[$i + 1]; $i++ }
  elseif ($a -like "--env=*") { $kv = $a.Substring(6) }
  elseif ($a -like "-e=*")    { $kv = $a.Substring(3) }
  if ($kv -and $kv.Contains("=")) {
    $eq = $kv.IndexOf("=")
    [Environment]::SetEnvironmentVariable($kv.Substring(0, $eq), $kv.Substring($eq + 1), "Process")
  }
}

# Run id encodes the run shape so output files are self-describing.
$U = if ($env:USERS) { $env:USERS } else { "1" }
$C = if ($env:CYCLES_PER_USER) { $env:CYCLES_PER_USER } else { "100" }
$RunId = "${U}u-${C}c-$Stamp"
$ReqFile     = Join-Path $ResultsDir "requests-$RunId.csv"
$ReqLatest   = Join-Path $ResultsDir "requests-latest.csv"
$SummaryFile = Join-Path $ResultsDir "summary-$RunId.json"
$ReportFile  = Join-Path $ResultsDir "report-$RunId.csv"

# Run k6. Decode the per-request log lines (@@REQ@@ / @@REQHDR@@ <base64>) into a
# CSV as they stream past; print everything else live.
$reqWriter = $null
$reqRegex  = [regex]'@@REQ(?:HDR)?@@ ([A-Za-z0-9+/=]+)'

& k6 run "-e" "RUN_ID=$RunId" @args $Script 2>&1 | ForEach-Object {
  $line = "$_"
  $m = $reqRegex.Match($line)
  if ($m.Success) {
    if (-not $reqWriter) {
      $reqWriter = [System.IO.StreamWriter]::new($ReqFile, $false, [System.Text.UTF8Encoding]::new($false))
    }
    $reqWriter.WriteLine([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($m.Groups[1].Value)))
  } else {
    Write-Host $line
  }
}
$k6Exit = $LASTEXITCODE
if ($reqWriter) { $reqWriter.Close() }

Write-Host ""
if (Test-Path $ReqFile) {
  Copy-Item $ReqFile $ReqLatest -Force
  $rowCount = (Get-Content $ReqFile | Measure-Object -Line).Lines - 1
  Write-Host "Per-request log: results/requests-$RunId.csv  ($rowCount rows)"

  # Fold the request rows into THIS run's JSON summaries only (set
  # EMBED_REQUESTS_IN_JSON=false to skip).
  if ($env:EMBED_REQUESTS_IN_JSON -ne "false") {
    try {
      $rows = @(Import-Csv $ReqFile | ForEach-Object {
        [pscustomobject]@{
          index          = [int]$_.index
          userId         = $_.userId
          environment    = $_.environment
          api            = $_.api
          routingNumber  = $_.routingNumber
          requestUrl     = $_.requestUrl
          requestBody    = $_.requestBody
          status         = [int]$_.status
          ok             = ($_.ok -eq "true")
          responseTimeMs = if ($_.responseTimeMs) { [double]$_.responseTimeMs } else { $null }
          timestamp      = $_.timestamp
          errorMessage   = $_.errorMessage
          responseBody   = $_.responseBody
        }
      })
      $utf8NoBom = New-Object System.Text.UTF8Encoding $false
      foreach ($jsonPath in @($SummaryFile, (Join-Path $ResultsDir "summary-latest.json"))) {
        if (-not (Test-Path $jsonPath)) { continue }
        $obj = Get-Content $jsonPath -Raw | ConvertFrom-Json
        $obj | Add-Member -NotePropertyName "requestLogFile" -NotePropertyValue "results/requests-$RunId.csv" -Force
        $obj | Add-Member -NotePropertyName "requestCount"   -NotePropertyValue $rows.Count -Force
        $obj | Add-Member -NotePropertyName "requests"       -NotePropertyValue $rows -Force
        [System.IO.File]::WriteAllText($jsonPath, ($obj | ConvertTo-Json -Depth 8), $utf8NoBom)
      }
      Write-Host "Embedded $($rows.Count) request rows into results/summary-$RunId.json"
    } catch {
      Write-Host "  (could not embed requests into JSON: $($_.Exception.Message))"
    }
  }
}

# Append the full run summary to the bottom of the per-request CSV (one sheet has
# everything). Toggle off with APPEND_SUMMARY_CSV=false.
if ($env:APPEND_SUMMARY_CSV -ne "false") {
  if ((Test-Path $ReqFile) -and (Test-Path $ReportFile)) {
    $block = Get-Content $ReportFile
    foreach ($target in @($ReqFile, $ReqLatest)) {
      Add-Content -Path $target -Value "" -Encoding utf8
      Add-Content -Path $target -Value $block -Encoding utf8
    }
    Remove-Item $ReportFile -Force  # folded into requests-*.csv; no separate file
    Write-Host "Appended run summary to results/requests-$RunId.csv (and requests-latest.csv)"
  }
}

Write-Host "k6 exit code: $k6Exit  (0 = all thresholds passed, 99 = a threshold failed)"
exit $k6Exit
