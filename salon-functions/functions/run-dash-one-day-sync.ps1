param(
  [ValidateSet("DryRun", "Apply")]
  [string]$Mode = "DryRun"
)

$ErrorActionPreference = "Stop"
$projectId = "rosesnails-calendar"
$date = "2026-09-28"
$confirmation = "ROSES-2026-09-28-9-ACTIONS"
$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path -LiteralPath $chromePath)) {
  throw "Google Chrome was not found at the guarded executable path."
}

try {
  $arguments = @(
    "dash-one-day-apply-cli.js",
    "--project=$projectId",
    "--date=$date",
    "--executable=$chromePath"
  )
  if ($Mode -eq "Apply") {
    $env:DASH_ONE_DAY_ENABLE_WRITES = "YES"
    $arguments += "--apply"
    $arguments += "--confirm=$confirmation"
  }
  & node @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "The guarded one-day sync command failed."
  }
} finally {
  Remove-Item Env:DASH_ONE_DAY_ENABLE_WRITES -ErrorAction SilentlyContinue
}
