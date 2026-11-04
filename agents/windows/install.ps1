# FleetControl · instalador del agente para Windows (Lenovo u otros)
# Uso (PowerShell como Administrador):
#   powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm __SERVER_URL__/install/windows.ps1))) -Token TOKEN"
param([Parameter(Mandatory = $true)][string]$Token)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Server = '__SERVER_URL__'
$Dir = Join-Path $env:ProgramData 'FleetControl'
$TaskName = 'FleetControl Agent'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Ejecuta PowerShell como Administrador.'
}

Write-Host "-> Descargando agente desde $Server"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# Solo SYSTEM y Administradores pueden leer la carpeta (contiene el token del equipo)
icacls $Dir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Invoke-WebRequest -Uri "$Server/agent/windows/agent.ps1" -OutFile (Join-Path $Dir 'agent.ps1') -UseBasicParsing

$cs = Get-CimInstance Win32_ComputerSystem
$serial = (Get-CimInstance Win32_BIOS).SerialNumber
Write-Host "-> Registrando el equipo $env:COMPUTERNAME ($serial)"
$body = @{ token = $Token; platform = 'windows'; hostname = $env:COMPUTERNAME; serial = $serial;
           manufacturer = $cs.Manufacturer; model = $cs.Model } | ConvertTo-Json
try {
  $resp = Invoke-WebRequest -Uri "$Server/api/agent/enroll" -Method Post -Body $body -ContentType 'application/json' -UseBasicParsing
} catch { throw "El servidor rechazó el registro (¿token correcto?): $($_.Exception.Message)" }
$text = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
$id = ([regex]::Match($text, 'DEVICE_ID=(\S+)')).Groups[1].Value
$tok = ([regex]::Match($text, 'DEVICE_TOKEN=(\S+)')).Groups[1].Value
if (-not $id -or -not $tok) { throw "Respuesta inesperada: $text" }

@{ ServerUrl = $Server; DeviceId = $id; DeviceToken = $tok } | ConvertTo-Json |
  Set-Content -Path (Join-Path $Dir 'config.json') -Encoding UTF8

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\agent.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$startup = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$sys = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $startup) -Settings $settings -Principal $sys | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host ''
Write-Host 'OK: agente instalado. El equipo aparecerá en el panel en menos de un minuto.' -ForegroundColor Green
