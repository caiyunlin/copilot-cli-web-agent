<#
.SYNOPSIS
  Start the Copilot ACP Web Agent server and expose it via Dev Tunnel.
.PARAMETER Port
  Local port for the web server (default: 3000).
.PARAMETER Cwd
  Working directory for Copilot CLI sessions (default: current directory).
.PARAMETER CliArgs
  Extra arguments passed to Copilot CLI, comma-separated (e.g. "--model,gpt-4").
.PARAMETER Password
  If set, users must enter this password in the web UI before chatting.
.PARAMETER NoTunnel
  Skip creating the dev tunnel (local-only mode).
#>
param(
  [int]$Port = 3000,
  [string]$Cwd,
  [string]$CliArgs,
  [string]$Password,
  [switch]$NoTunnel
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot  # demo/agent

Push-Location $root
try {
  # 1. Check prerequisites
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js is not installed. Please install Node.js >= 18."
  }
  if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) {
    Write-Warning "Copilot CLI not found in PATH. Set COPILOT_CLI_PATH env var if installed elsewhere."
  }

  # 2. Install dependencies if needed
  if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Cyan
    npm install
  }

  # 3. Build TypeScript
  Write-Host "Building TypeScript..." -ForegroundColor Cyan
  npx tsc

  # 4. Start the server
  Write-Host "Starting server on port $Port..." -ForegroundColor Green
  $env:PORT = $Port

  # Build node args
  $nodeArgs = "dist/server.js"
  if ($Cwd)      { $nodeArgs += " --cwd `"$Cwd`"" }
  if ($CliArgs)  { $nodeArgs += " --cli-args `"$CliArgs`"" }
  if ($Password) { $nodeArgs += " --password `"$Password`"" }

  $serverProcess = Start-Process -FilePath node -ArgumentList $nodeArgs `
    -WorkingDirectory $root -PassThru -NoNewWindow

  Write-Host "Server started (PID: $($serverProcess.Id))" -ForegroundColor Green
  if ($Password) { Write-Host "Password protection: enabled" -ForegroundColor Yellow }

  # 5. Wait for the server to be ready (health check)
  $maxWait = 15
  $ready = $false
  for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 1
    if ($serverProcess.HasExited) {
      throw "Server exited unexpectedly with code $($serverProcess.ExitCode)."
    }
    try {
      $resp = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
      if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {
      # Not ready yet
    }
  }
  if (-not $ready) {
    throw "Server did not become ready within ${maxWait}s."
  }
  Write-Host "Server is listening on port $Port." -ForegroundColor Green

  # 6. Start Dev Tunnel
  if (-not $NoTunnel) {
    if (-not (Get-Command devtunnel -ErrorAction SilentlyContinue)) {
      Write-Warning "Dev Tunnel CLI not found. Install: winget install Microsoft.devtunnel"
      Write-Warning "Running in local-only mode. Access at http://localhost:$Port"
    } else {
      Write-Host ""
      Write-Host "Starting Dev Tunnel..." -ForegroundColor Cyan
      Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
      Write-Host ""
      devtunnel host -p $Port --allow-anonymous
    }
  } else {
    Write-Host "Running in local-only mode. Access at http://localhost:$Port" -ForegroundColor Yellow
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
    $serverProcess.WaitForExit()
  }
} finally {
  # Cleanup
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Write-Host "Stopping server..." -ForegroundColor Yellow
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
