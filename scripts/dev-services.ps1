<#
.SYNOPSIS
  Docker-siz lokal PostgreSQL + Redis servislarini boshqarish.

.DESCRIPTION
  Bu loyiha uchun portativ PostgreSQL 17 va Redis 8 nusxalari `.localdev/` ichida
  saqlanadi. Ular Windows servisi sifatida ro'yxatdan o'tmaydi, shuning uchun
  kompyuter o'chirilgandan keyin ushbu skript bilan qayta ishga tushiriladi.

  Standart 5432/6379 portlari bu mashinada band bo'lgani uchun 5434/6380 ishlatiladi
  (qiymatlar .env fayldagi DATABASE_URL / REDIS_URL bilan mos bo'lishi shart).

.EXAMPLE
  ./scripts/dev-services.ps1 start
  ./scripts/dev-services.ps1 status
  ./scripts/dev-services.ps1 stop
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$LocalDev  = Join-Path $Root '.localdev'
$PgBin     = Join-Path $LocalDev 'pgsql\bin'
$PgData    = Join-Path $LocalDev 'pgdata'
$PgLog     = Join-Path $LocalDev 'postgres.log'
$RedisDir  = Join-Path $LocalDev 'redis8\Redis-8.0.2-Windows-x64-msys2'

$PgPort    = 5434
$RedisPort = 6380
$RedisPass = 'devredispass123'

function Test-Port {
    param([int]$Port)
    $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-Postgres {
    if (Test-Port $PgPort) {
        Write-Host "  postgres  : already running on $PgPort" -ForegroundColor DarkGray
        return
    }
    # pg_ctl Windows'da ba'zan noto'g'ri "could not start" qaytaradi, shuning uchun
    # natijani portni tekshirib aniqlaymiz.
    # Start-Process orqali: Windows PowerShell 5.1 da `2>&1` + ErrorActionPreference=Stop
    # pg_ctl'ning zararsiz stderr ogohlantirishini (noto'g'ri o'chirilgandan keyin
    # qolgan postmaster.pid) fatal xatoga aylantirib, pg_ctl'ni ishga tushirmay o'ldiradi.
    Start-Process -FilePath "$PgBin\pg_ctl.exe" `
        -ArgumentList '-D', "`"$PgData`"", '-l', "`"$PgLog`"", '-o', "`"-p $PgPort`"", 'start' `
        -WindowStyle Hidden
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Port $PgPort) { break }
    }
    if (Test-Port $PgPort) {
        Write-Host "  postgres  : started on $PgPort" -ForegroundColor Green
    } else {
        Write-Host "  postgres  : FAILED - see $PgLog" -ForegroundColor Red
    }
}

function Start-Redis {
    if (Test-Port $RedisPort) {
        Write-Host "  redis     : already running on $RedisPort" -ForegroundColor DarkGray
        return
    }
    # msys2 build POSIX yo'llarni kutadi, shuning uchun konfig nisbiy nom bilan
    # va WorkingDirectory orqali beriladi.
    Start-Process -FilePath "$RedisDir\redis-server.exe" `
        -ArgumentList 'redis-local.conf' `
        -WorkingDirectory $RedisDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $LocalDev 'redis-out.log') `
        -RedirectStandardError  (Join-Path $LocalDev 'redis-err.log')
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Port $RedisPort) { break }
    }
    if (Test-Port $RedisPort) {
        Write-Host "  redis     : started on $RedisPort" -ForegroundColor Green
    } else {
        Write-Host "  redis     : FAILED - see $LocalDev\redis-out.log" -ForegroundColor Red
    }
}

function Stop-Postgres {
    if (-not (Test-Port $PgPort)) {
        Write-Host "  postgres  : not running" -ForegroundColor DarkGray
        return
    }
    & "$PgBin\pg_ctl.exe" -D $PgData -m fast stop 2>&1 | Out-Null
    Write-Host "  postgres  : stopped" -ForegroundColor Yellow
}

function Stop-Redis {
    if (-not (Test-Port $RedisPort)) {
        Write-Host "  redis     : not running" -ForegroundColor DarkGray
        return
    }
    & "$RedisDir\redis-cli.exe" -h 127.0.0.1 -p $RedisPort -a $RedisPass --no-auth-warning shutdown nosave 2>&1 | Out-Null
    Write-Host "  redis     : stopped" -ForegroundColor Yellow
}

function Show-Status {
    if (Test-Port $PgPort) {
        Write-Host "  postgres  : UP    localhost:$PgPort" -ForegroundColor Green
    } else {
        Write-Host "  postgres  : DOWN  (localhost:$PgPort)" -ForegroundColor Red
    }
    if (Test-Port $RedisPort) {
        Write-Host "  redis     : UP    localhost:$RedisPort" -ForegroundColor Green
    } else {
        Write-Host "  redis     : DOWN  (localhost:$RedisPort)" -ForegroundColor Red
    }
}

Write-Host ""
switch ($Action) {
    'start'   { Write-Host "Starting local dev services..." -ForegroundColor Cyan; Start-Postgres; Start-Redis }
    'stop'    { Write-Host "Stopping local dev services..." -ForegroundColor Cyan; Stop-Redis; Stop-Postgres }
    'restart' { Write-Host "Restarting local dev services..." -ForegroundColor Cyan; Stop-Redis; Stop-Postgres; Start-Sleep -Seconds 2; Start-Postgres; Start-Redis }
    'status'  { Write-Host "Local dev services:" -ForegroundColor Cyan; Show-Status }
}
Write-Host ""
