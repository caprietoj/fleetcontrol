# FleetControl · agente para Windows
# Lo ejecuta una tarea programada ("FleetControl Agent") como SYSTEM cada minuto.
$AgentVersion = '1.0.0'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Dir  = Join-Path $env:ProgramData 'FleetControl'
$Log  = Join-Path $Dir 'agent.log'
$Conf = Get-Content (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json
$Server = $Conf.ServerUrl.TrimEnd('/')
$Headers = @{ 'X-Device-Id' = $Conf.DeviceId; 'X-Device-Token' = $Conf.DeviceToken }
$MaxRuntimeSec = 3600
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Write-Log($m) { Add-Content -Path $Log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item $Log "$Log.1" -Force }

function Get-Inventory {
  $cs   = Get-CimInstance Win32_ComputerSystem
  $prod = Get-CimInstance Win32_ComputerSystemProduct
  $bios = Get-CimInstance Win32_BIOS
  $os   = Get-CimInstance Win32_OperatingSystem
  $cpu  = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
  $model = $cs.Model
  if ($cs.Manufacturer -match 'LENOVO' -and $prod.Version) { $model = "$($prod.Version) ($($cs.Model))" }
  $ip = $null
  try {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
      Sort-Object InterfaceMetric | Select-Object -First 1).IPAddress
  } catch {}
  # Cuentas de Google con sesión en Chrome/Edge/Brave
  $accounts = @()
  $profiles = Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special -and $_.LocalPath }
  foreach ($p in $profiles) {
    foreach ($rel in 'AppData\Local\Google\Chrome\User Data\Local State', 'AppData\Local\Microsoft\Edge\User Data\Local State', 'AppData\Local\BraveSoftware\Brave-Browser\User Data\Local State') {
      $f = Join-Path $p.LocalPath $rel
      if (Test-Path $f) {
        try {
          $txt = [IO.File]::ReadAllText($f)
          foreach ($m in [regex]::Matches($txt, '"user_name":"([^"]*@[^"]*)"')) { $accounts += $m.Groups[1].Value }
        } catch {}
      }
    }
  }
  [ordered]@{
    platform        = 'windows'
    hostname        = $env:COMPUTERNAME
    serial          = $bios.SerialNumber
    manufacturer    = $cs.Manufacturer
    model           = $model
    os_version      = "$($os.Caption) $($os.Version)"
    cpu             = $cpu
    ram_gb          = [math]::Round($cs.TotalPhysicalMemory / 1GB)
    disk_total_gb   = [math]::Round($disk.Size / 1GB, 1)
    disk_free_gb    = [math]::Round($disk.FreeSpace / 1GB, 1)
    ip              = $ip
    logged_user     = $cs.UserName
    google_accounts = @($accounts | Sort-Object -Unique)
    agent_version   = $AgentVersion
  }
}

# ---------- check-in ----------
try {
  $body = $Utf8.GetBytes((Get-Inventory | ConvertTo-Json -Compress))
  Invoke-WebRequest -Uri "$Server/api/agent/checkin" -Method Post -Headers $Headers -Body $body `
    -ContentType 'application/json; charset=utf-8' -UseBasicParsing | Out-Null
} catch {
  Write-Log "check-in falló: $($_.Exception.Message)"
  exit 0
}

# ---------- ejecutar comandos pendientes ----------
$Tmp = Join-Path $env:TEMP ('fcagent_' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  for ($i = 0; $i -lt 25; $i++) {
    $r = Invoke-WebRequest -Uri "$Server/api/agent/next" -Headers $Headers -UseBasicParsing
    if ($r.StatusCode -ne 200) { break }
    $cid = @($r.Headers['X-Command-Id'])[0]
    if (-not $cid) { break }
    $script = $Utf8.GetString($r.RawContentStream.ToArray())
    $file = Join-Path $Tmp "cmd_$cid.ps1"
    [IO.File]::WriteAllText($file, $script, (New-Object System.Text.UTF8Encoding $true))
    $out = Join-Path $Tmp "out_$cid.txt"; $err = Join-Path $Tmp "err_$cid.txt"
    Write-Log "Ejecutando comando $cid"

    $p = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
      -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"" `
      -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
    $null = $p.Handle
    if ($p.WaitForExit($MaxRuntimeSec * 1000)) { $rc = $p.ExitCode } else { try { $p.Kill() } catch {}; $rc = 124 }

    $text = ''
    if (Test-Path $out) { $text += [IO.File]::ReadAllText($out) }
    if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) { $text += "`n--- errores ---`n" + [IO.File]::ReadAllText($err) }
    if ($rc -eq 124) { $text += "`nTiempo máximo de ejecución alcanzado ($MaxRuntimeSec s)" }

    $h = $Headers.Clone(); $h['X-Exit-Code'] = "$rc"
    try {
      Invoke-WebRequest -Uri "$Server/api/agent/result/$cid" -Method Post -Headers $h -Body $Utf8.GetBytes($text) `
        -ContentType 'text/plain; charset=utf-8' -UseBasicParsing | Out-Null
    } catch { Write-Log "No se pudo enviar el resultado de ${cid}: $($_.Exception.Message)" }
    Write-Log "Comando $cid terminó con código $rc"
  }
} catch {
  Write-Log "Error: $($_.Exception.Message)"
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- autodesinstalación ----------
if (Test-Path (Join-Path $Dir '.remove')) {
  Write-Log 'Desinstalando agente'
  Unregister-ScheduledTask -TaskName 'FleetControl Agent' -Confirm:$false -ErrorAction SilentlyContinue
  Set-Location $env:SystemRoot
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
