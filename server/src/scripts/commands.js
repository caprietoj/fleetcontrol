'use strict';
// Valida las acciones solicitadas desde el panel y genera el script que
// ejecutará el agente en cada equipo (bash en macOS, PowerShell en Windows).
const { browserTargets, ITEMS, BROWSERS } = require('./browsers');

// ---------- quoting ----------
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** Comillas para bash conservando "*" como comodín. */
const shGlob = (s) => String(s).split('*').map((p) => (p ? shq(p) : '')).join('*');
const winPath = (s) => String(s).replace(/\//g, '\\');

class ValidationError extends Error {}
const fail = (m) => { throw new ValidationError(m); };

const SAFE_PATH = /^[\p{L}\p{N} _.\-\/\\~*:()@+,&'#\[\]]+$/u;
const SAFE_USER = /^[A-Za-z0-9._\- ]{0,64}$/;

function validUser(u) {
  u = (u || '').trim();
  if (!SAFE_USER.test(u)) fail('Nombre de usuario no válido.');
  return u;
}

// ---------- rutas para borrar archivos ----------
const FILE_PRESETS = {
  downloads: { label: 'Descargas', mac: 'Downloads/*', win: 'Downloads/*' },
  desktop: { label: 'Escritorio', mac: 'Desktop/*', win: 'Desktop/*' },
  documents: { label: 'Documentos', mac: 'Documents/*', win: 'Documents/*' },
  trash: { label: 'Papelera', mac: '.Trash/*', win: null },
  temp: { label: 'Temporales y cachés', mac: 'Library/Caches/*', win: 'AppData/Local/Temp/*' },
};

const BLOCKED_HOME = new Set(['~', '~/', '~/*', '~/library', '~/appdata', '~/library/*', '~/appdata/*']);
const SYSTEM_PREFIXES = ['/system', '/usr', '/bin', '/sbin', '/private/var/db', '/library/apple', 'c:/windows', 'c:/program files/windowsapps'];

function validatePath(p) {
  p = String(p || '').trim();
  if (!p) return null;
  if (!SAFE_PATH.test(p)) fail(`Ruta con caracteres no permitidos: ${p}`);
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const lower = norm.toLowerCase();
  if (!norm || /^[a-z]:$/i.test(norm)) fail(`Ruta demasiado amplia: ${p}`);
  if (norm.split('/').includes('..')) fail(`No se permite ".." en rutas: ${p}`);
  if (lower.startsWith('~')) {
    if (BLOCKED_HOME.has(lower) || lower.startsWith('~/*')) fail(`Ruta demasiado amplia: ${p}`);
    if (!lower.startsWith('~/')) fail(`Usa "~/" para rutas dentro del usuario: ${p}`);
    return { home: true, rel: norm.slice(2), raw: p };
  }
  const isWinAbs = /^[a-z]:\//.test(lower);
  if (!lower.startsWith('/') && !isWinAbs) fail(`La ruta debe empezar por "~/", "/" o "C:\\": ${p}`);
  if (SYSTEM_PREFIXES.some((s) => lower === s || lower.startsWith(s + '/'))) fail(`Ruta del sistema protegida: ${p}`);
  const depth = norm.split('/').filter(Boolean).length - (isWinAbs ? 1 : 0);
  if (depth < 3) fail(`Ruta demasiado amplia (mínimo 3 niveles, p. ej. /Users/ana/Descargas): ${p}`);
  return { home: false, abs: norm, raw: p, platform: isWinAbs ? 'windows' : 'macos' };
}

// ---------- catálogo de acciones ----------
const TYPES = {
  clean_browsers: 'Limpiar navegadores',
  google_signout: 'Cerrar sesiones de Google',
  delete_files: 'Eliminar archivos',
  install_software: 'Instalar software',
  uninstall_software: 'Desinstalar software',
  list_software: 'Inventario de software',
  run_script: 'Ejecutar script',
  message: 'Enviar mensaje',
  restart: 'Reiniciar',
  shutdown: 'Apagar',
  update_agent: 'Actualizar agente',
  remove_agent: 'Desinstalar agente',
  wake_on_lan: 'Encender (Wake-on-LAN)',
  enable_remote: 'Preparar acceso remoto',
  disable_remote: 'Desactivar acceso remoto',
};

/** Valida el payload. Devuelve { payload, summary }. */
function prepare(type, p, ctx) {
  p = p || {};
  switch (type) {
    case 'clean_browsers': {
      const browsers = (p.browsers || []).filter((b) => BROWSERS.includes(b));
      const items = (p.items || []).filter((i) => ITEMS.includes(i));
      if (!browsers.length) fail('Selecciona al menos un navegador.');
      if (!items.length) fail('Selecciona qué datos borrar.');
      const user = validUser(p.user);
      return {
        payload: { browsers, items, user, close_browsers: p.close_browsers !== false },
        summary: `${items.join(', ')} · ${browsers.join(', ')}${user ? ' · usuario ' + user : ''}`,
      };
    }
    case 'google_signout': {
      const extra = (p.extra_emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      for (const e of extra) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(`Correo no válido: ${e}`);
      return {
        payload: { extra_emails: extra, revoke_tokens: Boolean(p.revoke_tokens), clear_cookies: p.clear_cookies !== false },
        summary: `Workspace signOut${p.revoke_tokens ? ' + revocar apps' : ''}${p.clear_cookies !== false ? ' + borrar cookies locales' : ''}`,
      };
    }
    case 'delete_files': {
      const presets = (p.presets || []).filter((x) => FILE_PRESETS[x]);
      const paths = (p.paths || []).map(validatePath).filter(Boolean);
      if (!presets.length && !paths.length) fail('Selecciona carpetas o escribe rutas.');
      const user = validUser(p.user);
      return {
        payload: { presets, paths, user },
        summary: [...presets.map((x) => FILE_PRESETS[x].label), ...paths.map((x) => x.raw)].join(', ') + (user ? ` · usuario ${user}` : ''),
      };
    }
    case 'install_software':
    case 'uninstall_software': {
      if (type === 'install_software') {
        const mac = p.mac_package_id ? ctx.getPackage(p.mac_package_id) : null;
        const win = p.win_package_id ? ctx.getPackage(p.win_package_id) : null;
        if (!mac && !win) fail('Selecciona un paquete para Mac y/o Windows.');
        if (mac && mac.platform !== 'macos') fail('El paquete de Mac no es de macOS.');
        if (win && win.platform !== 'windows') fail('El paquete de Windows no es de Windows.');
        return {
          payload: { mac: mac || null, win: win || null },
          summary: [mac && `Mac: ${mac.name}`, win && `Windows: ${win.name}`].filter(Boolean).join(' · '),
        };
      }
      const macApp = String(p.mac_app || '').trim().replace(/\.app$/i, '');
      const winName = String(p.win_name || '').trim();
      if (!macApp && !winName) fail('Indica el nombre de la aplicación.');
      if (macApp && !/^[\p{L}\p{N} ._\-+()&]+$/u.test(macApp)) fail('Nombre de app de Mac no válido.');
      if (winName && !/^[\p{L}\p{N} ._\-+()&]+$/u.test(winName)) fail('Nombre de programa de Windows no válido.');
      return { payload: { mac_app: macApp, win_name: winName }, summary: [macApp && `Mac: ${macApp}`, winName && `Windows: ${winName}`].filter(Boolean).join(' · ') };
    }
    case 'run_script': {
      const mac = String(p.mac_script || '');
      const win = String(p.win_script || '');
      if (!mac.trim() && !win.trim()) fail('Escribe un script.');
      if (mac.length + win.length > 200_000) fail('Script demasiado largo.');
      const first = (mac || win).trim().split('\n')[0].slice(0, 80);
      return { payload: { mac_script: mac, win_script: win }, summary: first };
    }
    case 'message': {
      const title = String(p.title || 'Aviso de TI').slice(0, 80);
      const text = String(p.text || '').trim().slice(0, 500);
      if (!text) fail('Escribe el mensaje.');
      return { payload: { title, text }, summary: text.slice(0, 80) };
    }
    case 'restart':
    case 'shutdown': {
      const delay = Math.max(1, Math.min(120, parseInt(p.delay_min, 10) || 1));
      return { payload: { delay_min: delay }, summary: `en ${delay} min` };
    }
    case 'wake_on_lan': {
      const mac = String(p.mac || '').trim().replace(/-/g, ':').toUpperCase();
      if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac)) fail('Dirección MAC no válida.');
      const bcasts = (Array.isArray(p.bcasts) ? p.bcasts : [])
        .map((b) => String(b).trim())
        .filter((b) => /^(\d{1,3}\.){3}\d{1,3}$/.test(b));
      return { payload: { mac, bcasts: [...new Set(bcasts)].slice(0, 8) }, summary: `Magic packet → ${mac}` };
    }
    case 'enable_remote': {
      const port = parseInt(p.port, 10);
      const password = String(p.password || '');
      const frpAddr = String(p.frp_addr || '').trim();
      const frpPort = parseInt(p.frp_port, 10) || 443;
      const frpToken = String(p.frp_token || '');
      const tls = p.tls !== false;
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Puerto remoto no válido.');
      if (!/^[A-Za-z0-9]{8}$/.test(password)) fail('La contraseña VNC debe tener 8 caracteres alfanuméricos.');
      if (!/^[a-z0-9.-]+$/i.test(frpAddr)) fail('Servidor de túnel no válido.');
      if (!Number.isInteger(frpPort) || frpPort < 1 || frpPort > 65535) fail('Puerto del túnel no válido.');
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(frpToken)) fail('Token del túnel no válido.');
      return {
        payload: { port, password, frp_addr: frpAddr, frp_port: frpPort, frp_token: frpToken, tls },
        summary: `VNC por túnel en el puerto ${port}${tls ? ' (WSS)' : ''}`,
      };
    }
    case 'disable_remote':
      return { payload: {}, summary: 'Cerrar túnel y desactivar VNC' };
    case 'list_software':
    case 'update_agent':
    case 'remove_agent':
      return { payload: {}, summary: '' };
    default:
      fail('Acción desconocida.');
  }
}

// =====================================================================
//  macOS (bash, se ejecuta como root)
// =====================================================================
function macHeader(type, user) {
  return `#!/bin/bash
# FleetControl · ${type}
shopt -s nullglob
TARGET_USER=${shq(user || '')}
FC_ERR=0
fc_homes() {
  for H in /Users/*; do
    U="\${H##*/}"
    case "$U" in Shared|Guest|.localized) continue;; esac
    [ -d "$H/Library" ] || continue
    if [ -n "$TARGET_USER" ] && [ "$U" != "$TARGET_USER" ]; then continue; fi
    printf '%s\\n' "$H"
  done
}
fc_del() {
  for p in "$@"; do
    if [ -e "$p" ] || [ -L "$p" ]; then
      if rm -rf -- "$p" 2>/dev/null; then echo "  OK  $p"; else echo "  ERR $p (¿falta Acceso total al disco para /bin/bash?)"; FC_ERR=1; fi
    fi
  done
}
`;
}

function macDeletePerHome(relPaths) {
  if (!relPaths.length) return '';
  const lines = relPaths.map((r) => `  fc_del "$H"/${shGlob(r)}`).join('\n');
  return `while IFS= read -r H; do
  echo "== $H"
${lines}
done < <(fc_homes)
`;
}

function macConsoleUser() {
  return `CU=$(stat -f%Su /dev/console); CUID=$(id -u "$CU" 2>/dev/null)\n`;
}

function buildMac(type, p, ctx) {
  switch (type) {
    case 'clean_browsers': {
      const { procs, paths } = browserTargets('macos', p.browsers, p.items);
      let s = macHeader(type, p.user);
      if (p.close_browsers) {
        s += procs.map((n) => `pkill -x ${shq(n)} && echo "Cerrado: ${n}"`).join('\n') + '\nsleep 3\n';
        s += procs.map((n) => `pkill -9 -x ${shq(n)} 2>/dev/null`).join('\n') + '\n';
      }
      s += macDeletePerHome(paths);
      s += 'echo "Limpieza terminada."\nexit $FC_ERR\n';
      return s;
    }
    case 'delete_files': {
      const rel = p.presets.map((x) => FILE_PRESETS[x].mac).filter(Boolean);
      const homeCustom = p.paths.filter((x) => x.home).map((x) => x.rel);
      const abs = p.paths.filter((x) => !x.home && x.platform === 'macos').map((x) => x.abs);
      let s = macHeader(type, p.user) + macDeletePerHome([...rel, ...homeCustom]);
      if (abs.length) s += `echo "== Rutas absolutas"\n` + abs.map((a) => `fc_del ${shGlob(a)}`).join('\n') + '\n';
      s += 'echo "Eliminación terminada."\nexit $FC_ERR\n';
      return s;
    }
    case 'install_software': {
      const pkg = p.mac;
      if (!pkg) return null;
      return `#!/bin/bash
# FleetControl · instalar ${pkg.name}
set -u
URL=${shq(pkg.source)}
KIND=${shq(pkg.kind)}
SHA=${shq(pkg.sha256 || '')}
ARGS=${shq(pkg.args || '')}
TMP=$(mktemp -d /tmp/fc.XXXXXX)
trap 'hdiutil detach "$TMP/mnt" -force >/dev/null 2>&1; rm -rf "$TMP"' EXIT
install_app() {
  local app="$1" name; name="$(basename "$app")"
  echo "Copiando $name a /Applications"
  rm -rf "/Applications/$name"
  ditto "$app" "/Applications/$name" || return 1
  xattr -dr com.apple.quarantine "/Applications/$name" 2>/dev/null
  return 0
}
echo "Descargando ${pkg.name}..."
curl -fsSL --retry 3 -o "$TMP/file" "$URL" || { echo "Error: no se pudo descargar $URL"; exit 1; }
if [ -n "$SHA" ]; then
  CALC=$(shasum -a 256 "$TMP/file" | awk '{print $1}')
  [ "$CALC" = "$SHA" ] || { echo "Error: SHA-256 no coincide ($CALC)"; exit 1; }
fi
case "$KIND" in
  pkg)
    installer -pkg "$TMP/file" -target / $ARGS ;;
  dmg)
    mkdir -p "$TMP/mnt"
    yes | hdiutil attach "$TMP/file" -nobrowse -noautoopen -mountpoint "$TMP/mnt" >/dev/null || { echo "Error montando DMG"; exit 1; }
    APP=$(find "$TMP/mnt" -maxdepth 1 -name '*.app' -print -quit)
    PKG=$(find "$TMP/mnt" -maxdepth 1 \\( -name '*.pkg' -o -name '*.mpkg' \\) -print -quit)
    if [ -n "$APP" ]; then install_app "$APP"
    elif [ -n "$PKG" ]; then installer -pkg "$PKG" -target / $ARGS
    else echo "Error: el DMG no contiene .app ni .pkg"; exit 1; fi ;;
  zip)
    ditto -x -k "$TMP/file" "$TMP/x" || exit 1
    APP=$(find "$TMP/x" -maxdepth 2 -name '*.app' -print -quit)
    [ -n "$APP" ] || { echo "Error: el ZIP no contiene .app"; exit 1; }
    install_app "$APP" ;;
  *) echo "Tipo de paquete no soportado en macOS: $KIND"; exit 1 ;;
esac
RC=$?
[ $RC -eq 0 ] && echo "Instalado correctamente." || echo "La instalación terminó con código $RC"
exit $RC
`;
    }
    case 'uninstall_software': {
      if (!p.mac_app) return null;
      return `#!/bin/bash
APP=${shq(p.mac_app)}
pkill -x "$APP" 2>/dev/null; sleep 1
if [ -d "/Applications/$APP.app" ]; then
  rm -rf "/Applications/$APP.app" && echo "Eliminado /Applications/$APP.app"
else
  echo "No se encontró /Applications/$APP.app"; exit 1
fi
for H in /Users/*; do rm -rf "$H/Applications/$APP.app" 2>/dev/null; done
exit 0
`;
    }
    case 'wake_on_lan': {
      const bcasts = p.bcasts.length ? p.bcasts : ['255.255.255.255'];
      return `#!/bin/bash
# FleetControl · Wake-on-LAN
MAC=${shq(p.mac)}
BCASTS=(${bcasts.map(shq).join(' ')})
HEX=$(printf '%s' "$MAC" | tr -d ':-')
perl -MSocket -e '
  my ($hex, @b) = @ARGV;
  my $m = pack("H*", $hex);
  my $pkt = ("\\xff" x 6) . ($m x 16);
  socket(my $s, PF_INET, SOCK_DGRAM, getprotobyname("udp")) or die "socket: $!";
  setsockopt($s, SOL_SOCKET, SO_BROADCAST, 1) or die "broadcast: $!";
  for my $port (7, 9) {
    for my $addr (@b) {
      send($s, $pkt, 0, sockaddr_in($port, inet_aton($addr)));
    }
  }
' "$HEX" "\${BCASTS[@]}" || { echo "No se pudo enviar el magic packet"; exit 1; }
echo "Magic packet enviado a $MAC"
`;
    }
    case 'enable_remote': {
      const tls = p.tls !== false;
      const proto = tls ? 'wss' : 'websocket';
      return `#!/bin/bash
# FleetControl · acceso remoto (VNC + túnel frp)
set -u
PASS=${shq(p.password)}
PORT=${p.port}
FRP_ADDR=${shq(p.frp_addr)}
FRP_PORT=${p.frp_port}
FRP_TOKEN=${shq(p.frp_token)}
DIR="/Library/Application Support/FleetControl"
TUN="$DIR/tunnel"
mkdir -p "$TUN"
chmod 700 "$TUN"
case "$(uname -m)" in
  arm64|aarch64) BIN=frpc-darwin-arm64 ;;
  *) BIN=frpc-darwin-amd64 ;;
esac
curl -fsSL ${shq(ctx.serverUrl + '/tools/')}"$BIN" -o "$TUN/frpc.new" || { echo "Error descargando el cliente del túnel"; exit 1; }
chmod 755 "$TUN/frpc.new"
xattr -d com.apple.quarantine "$TUN/frpc.new" 2>/dev/null || true
mv -f "$TUN/frpc.new" "$TUN/frpc"
cat > "$TUN/frpc.toml" <<'FCEOF'
serverAddr = ${JSON.stringify(p.frp_addr)}
serverPort = ${p.frp_port}
auth.method = "token"
auth.token = ${JSON.stringify(p.frp_token)}
transport.protocol = ${JSON.stringify(proto)}
transport.tls.enable = ${tls ? 'true' : 'false'}
transport.dialServerTimeout = 20
log.level = "warn"

[[proxies]]
name = "vnc"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5900
remotePort = ${p.port}
FCEOF
chmod 600 "$TUN/frpc.toml"
ARD=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
[ -x "$ARD" ] || { echo "No se encontró Screen Sharing/ARD en este Mac"; exit 1; }
"$ARD" -activate -configure -access -on -restart -agent -privs -all \
  -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw "$PASS" >/dev/null 2>&1 \
  || { echo "No se pudo activar Screen Sharing"; exit 1; }
cat > /Library/LaunchDaemons/com.fleetcontrol.tunnel.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fleetcontrol.tunnel</string>
  <key>ProgramArguments</key>
  <array><string>$TUN/frpc</string><string>-c</string><string>$TUN/frpc.toml</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TUN/frpc.log</string>
  <key>StandardErrorPath</key><string>$TUN/frpc.err</string>
</dict>
</plist>
PLIST
chown root:wheel /Library/LaunchDaemons/com.fleetcontrol.tunnel.plist
chmod 644 /Library/LaunchDaemons/com.fleetcontrol.tunnel.plist
launchctl bootout system/com.fleetcontrol.tunnel 2>/dev/null || true
launchctl bootstrap system /Library/LaunchDaemons/com.fleetcontrol.tunnel.plist || { echo "No se pudo iniciar el túnel"; exit 1; }
echo "Acceso remoto listo: VNC activo y túnel en el puerto $PORT"
`;
    }
    case 'disable_remote':
      return `#!/bin/bash
launchctl bootout system/com.fleetcontrol.tunnel 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.fleetcontrol.tunnel.plist
rm -rf "/Library/Application Support/FleetControl/tunnel"
ARD=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
[ -x "$ARD" ] && "$ARD" -deactivate -configure -access -off >/dev/null 2>&1 || true
echo "Acceso remoto desactivado"
`;
    case 'list_software':
      return `#!/bin/bash
for A in /Applications/*.app /Applications/*/*.app; do
  V=$(defaults read "$A/Contents/Info" CFBundleShortVersionString 2>/dev/null)
  printf '%s\\t%s\\n' "$(basename "$A" .app)" "\${V:--}"
done | sort -f
`;
    case 'run_script':
      return p.mac_script && p.mac_script.trim() ? (p.mac_script.startsWith('#!') ? p.mac_script : '#!/bin/bash\n' + p.mac_script) : null;
    case 'message': {
      const as = `display dialog ${JSON.stringify(p.text)} with title ${JSON.stringify(p.title)} buttons {"Entendido"} default button 1 with icon caution giving up after 600`;
      return `#!/bin/bash
${macConsoleUser()}[ -n "$CUID" ] && [ "$CU" != "root" ] || { echo "No hay usuario con sesión iniciada"; exit 0; }
launchctl asuser "$CUID" sudo -u "$CU" osascript -e ${shq(as)} >/dev/null 2>&1 &
echo "Mensaje mostrado a $CU"
`;
    }
    case 'restart':
    case 'shutdown':
      return `#!/bin/bash
shutdown ${type === 'restart' ? '-r' : '-h'} +${p.delay_min} >/dev/null 2>&1 &
echo "${type === 'restart' ? 'Reinicio' : 'Apagado'} programado en ${p.delay_min} min"
`;
    case 'update_agent':
      return `#!/bin/bash
DIR="/Library/Application Support/FleetControl"
curl -fsSL ${shq(ctx.serverUrl + '/agent/macos/agent.sh')} -o "$DIR/agent.sh.new" && bash -n "$DIR/agent.sh.new" \\
  && mv "$DIR/agent.sh.new" "$DIR/agent.sh" && chmod 700 "$DIR/agent.sh" && echo "Agente actualizado" || { echo "Error actualizando"; exit 1; }
`;
    case 'remove_agent':
      return `#!/bin/bash
touch "/Library/Application Support/FleetControl/.remove"
rm -f /Library/LaunchDaemons/com.fleetcontrol.agent.plist
echo "El agente se desinstalará al terminar este ciclo."
`;
    default:
      return null;
  }
}

// =====================================================================
//  Windows (PowerShell 5.1+, se ejecuta como SYSTEM)
// =====================================================================
function winHeader(type, user) {
  return `# FleetControl · ${type}
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$TargetUser = ${psq(user || '')}
$script:FcErr = 0
function Get-FcHomes {
  Get-CimInstance Win32_UserProfile |
    Where-Object { -not $_.Special -and $_.LocalPath -and (Test-Path $_.LocalPath) } |
    ForEach-Object { $_.LocalPath } |
    Where-Object { -not $TargetUser -or ((Split-Path $_ -Leaf) -eq $TargetUser) }
}
function Remove-Fc([string]$Pattern) {
  foreach ($i in @(Get-Item -Path $Pattern -Force -ErrorAction SilentlyContinue)) {
    try { Remove-Item -LiteralPath $i.FullName -Recurse -Force -ErrorAction Stop; "  OK  $($i.FullName)" }
    catch { "  ERR $($i.FullName): $($_.Exception.Message)"; $script:FcErr = 1 }
  }
}
`;
}

function winDeletePerHome(relPaths) {
  if (!relPaths.length) return '';
  const lines = relPaths.map((r) => `  Remove-Fc (Join-Path $H ${psq(winPath(r))})`).join('\n');
  return `foreach ($H in Get-FcHomes) {
  "== $H"
${lines}
}
`;
}

const WINGET = `function Get-Winget {
  $c = Get-ChildItem "$env:ProgramFiles\\WindowsApps\\Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe\\winget.exe" -ErrorAction SilentlyContinue |
       Sort-Object FullName -Descending | Select-Object -First 1
  if ($c) { return $c.FullName }
  $g = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($g) { return $g.Source }
  return $null
}
`;

function buildWin(type, p, ctx) {
  switch (type) {
    case 'clean_browsers': {
      const { procs, paths } = browserTargets('windows', p.browsers, p.items);
      let s = winHeader(type, p.user);
      if (p.close_browsers && procs.length) {
        s += `Get-Process -Name ${procs.map(psq).join(',')} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue\nStart-Sleep -Seconds 3\n`;
      }
      s += winDeletePerHome(paths);
      s += '"Limpieza terminada."\nexit $script:FcErr\n';
      return s;
    }
    case 'delete_files': {
      const rel = p.presets.map((x) => FILE_PRESETS[x].win).filter(Boolean);
      const homeCustom = p.paths.filter((x) => x.home).map((x) => x.rel);
      const abs = p.paths.filter((x) => !x.home && x.platform === 'windows').map((x) => x.abs);
      let s = winHeader(type, p.user) + winDeletePerHome([...rel, ...homeCustom]);
      // OneDrive puede redirigir Escritorio/Documentos
      if (p.presets.some((x) => x === 'desktop' || x === 'documents')) {
        const od = p.presets.filter((x) => x === 'desktop' || x === 'documents').map((x) => (x === 'desktop' ? 'OneDrive*/Desktop/*' : 'OneDrive*/Documents/*'));
        s += winDeletePerHome(od);
      }
      if (p.presets.includes('trash')) {
        s += `"== Papelera de reciclaje"\nGet-PSDrive -PSProvider FileSystem | ForEach-Object { Remove-Fc (Join-Path $_.Root '$Recycle.Bin\\*\\*') }\n`;
      }
      if (abs.length) s += `"== Rutas absolutas"\n` + abs.map((a) => `Remove-Fc ${psq(winPath(a))}`).join('\n') + '\n';
      s += '"Eliminación terminada."\nexit $script:FcErr\n';
      return s;
    }
    case 'install_software': {
      const pkg = p.win;
      if (!pkg) return null;
      let s = `# FleetControl · instalar ${pkg.name}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Kind = ${psq(pkg.kind)}; $Src = ${psq(pkg.source)}; $Sha = ${psq(pkg.sha256 || '')}; $Args2 = ${psq(pkg.args || '')}
${WINGET}
try {
  if ($Kind -eq 'winget') {
    $wg = Get-Winget
    if (-not $wg) { throw 'winget no está disponible en este equipo.' }
    $a = @('install','--id',$Src,'-e','--silent','--scope','machine','--accept-package-agreements','--accept-source-agreements','--disable-interactivity')
    if ($Args2) { $a += $Args2 -split ' ' }
    & $wg @a 2>&1 | Out-String
    $rc = $LASTEXITCODE
    if ($rc -eq -1978335189) { 'Ya estaba instalado y actualizado.'; exit 0 }
    exit $rc
  }
  $tmp = Join-Path $env:TEMP ('fc_' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $file = Join-Path $tmp ('installer.' + $Kind)
  "Descargando $Src"
  Invoke-WebRequest -Uri $Src -OutFile $file -UseBasicParsing
  if ($Sha) {
    $h = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $Sha.ToLower()) { throw "SHA-256 no coincide ($h)" }
  }
  if ($Kind -eq 'msi') {
    $p = Start-Process msiexec.exe -ArgumentList "/i \`"$file\`" /qn /norestart $Args2" -Wait -PassThru
  } else {
    $p = Start-Process $file -ArgumentList $Args2 -Wait -PassThru
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -in 0, 3010, 1641) { "Instalado correctamente (código $($p.ExitCode))."; exit 0 }
  "El instalador terminó con código $($p.ExitCode)"; exit $p.ExitCode
} catch { "Error: $($_.Exception.Message)"; exit 1 }
`;
      return s;
    }
    case 'uninstall_software': {
      if (!p.win_name) return null;
      return `$ErrorActionPreference = 'Continue'
$Name = ${psq(p.win_name)}
${WINGET}
$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$apps = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*$Name*" }
if (-not $apps -and $Name -match '^[\\w-]+\\.[\\w.-]+$') {
  $wg = Get-Winget
  if ($wg) { & $wg uninstall --id $Name -e --silent --scope machine --accept-source-agreements --disable-interactivity 2>&1 | Out-String; exit $LASTEXITCODE }
}
if (-not $apps) { "No se encontró ningún programa que coincida con '$Name'."; exit 1 }
$rc = 0
foreach ($a in $apps) {
  "Desinstalando $($a.DisplayName) $($a.DisplayVersion)"
  if ($a.PSChildName -match '^\\{[0-9A-F-]+\\}$' -and $a.UninstallString -match 'msiexec') {
    $p = Start-Process msiexec.exe -ArgumentList "/x $($a.PSChildName) /qn /norestart" -Wait -PassThru
  } elseif ($a.QuietUninstallString) {
    $p = Start-Process cmd.exe -ArgumentList "/c $($a.QuietUninstallString)" -Wait -PassThru
  } else {
    $p = Start-Process cmd.exe -ArgumentList "/c $($a.UninstallString) /S /silent /quiet" -Wait -PassThru
  }
  "  código: $($p.ExitCode)"
  if ($p.ExitCode -notin 0, 3010, 1605) { $rc = $p.ExitCode }
}
exit $rc
`;
    }
    case 'wake_on_lan': {
      const bcasts = p.bcasts.length ? p.bcasts : ['255.255.255.255'];
      return `# FleetControl · Wake-on-LAN
$ErrorActionPreference = 'Stop'
$Mac = ${psq(p.mac)}
$Hex = ($Mac -replace '[:-]','')
$Packet = New-Object byte[] 102
for ($i = 0; $i -lt 6; $i++) { $Packet[$i] = 255 }
for ($i = 0; $i -lt 16; $i++) {
  for ($j = 0; $j -lt 6; $j++) {
    $Packet[6 + $i * 6 + $j] = [Convert]::ToByte($Hex.Substring($j * 2, 2), 16)
  }
}
$Udp = New-Object System.Net.Sockets.UdpClient
$Udp.EnableBroadcast = $true
foreach ($b in @(${bcasts.map(psq).join(', ')})) {
  foreach ($port in 7, 9) { $Udp.Send($Packet, $Packet.Length, $b, $port) | Out-Null }
}
$Udp.Close()
"Magic packet enviado a $Mac"
`;
    }
    case 'enable_remote': {
      const tls = p.tls !== false;
      const proto = tls ? 'wss' : 'websocket';
      return `# FleetControl · acceso remoto (VNC + túnel frp)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Pass = ${psq(p.password)}
$Port = ${p.port}
$Dir = Join-Path $env:ProgramData 'FleetControl\\tunnel'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Frpc = Join-Path $Dir 'frpc.exe'
Invoke-WebRequest -Uri ${psq(ctx.serverUrl + '/tools/frpc-windows-amd64.exe')} -OutFile "$Frpc.new" -UseBasicParsing
Move-Item "$Frpc.new" $Frpc -Force
$Cfg = @'
serverAddr = ${JSON.stringify(p.frp_addr)}
serverPort = ${p.frp_port}
auth.method = "token"
auth.token = ${JSON.stringify(p.frp_token)}
transport.protocol = ${JSON.stringify(proto)}
transport.tls.enable = ${tls ? 'true' : 'false'}
transport.dialServerTimeout = 20
log.level = "warn"

[[proxies]]
name = "vnc"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5900
remotePort = ${p.port}
'@
Set-Content -Path (Join-Path $Dir 'frpc.toml') -Value $Cfg -Encoding ASCII
# TightVNC (servidor) con contraseña
$Msi = Join-Path $env:TEMP 'tightvnc-fleetcontrol.msi'
Invoke-WebRequest -Uri ${psq(ctx.serverUrl + '/tools/tightvnc-2.8.88-gpl-setup-64bit.msi')} -OutFile $Msi -UseBasicParsing
$msiArgs = @('/i', "\`"$Msi\`"", '/quiet', '/norestart', 'ADDLOCAL=Server', 'SERVER_REGISTER_AS_SERVICE=1',
  'SERVER_START_AS_SERVICE=1', 'SERVER_ADD_FIREWALL_EXCEPTION=1', 'SET_USEVNCAUTHENTICATION=1',
  'VALUE_OF_USEVNCAUTHENTICATION=1', 'SET_PASSWORD=1', "VALUE_OF_PASSWORD=$Pass",
  'SET_ALLOWLOOPBACK=1', 'VALUE_OF_ALLOWLOOPBACK=1', 'SET_LOOPBACKONLY=1', 'VALUE_OF_LOOPBACKONLY=1')
$p = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
if ($p.ExitCode -notin 0, 3010) { throw "TightVNC terminó con código $($p.ExitCode)" }
Set-Service tvnserver -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service tvnserver -ErrorAction SilentlyContinue
$Tvn = Join-Path $env:ProgramFiles 'TightVNC\\tvnserver.exe'
if (Test-Path $Tvn) {
  & $Tvn -controlservice -setpassword $Pass | Out-Null
  $Tvk = 'HKLM:\\SOFTWARE\\TightVNC\\Server'
  New-Item -Path $Tvk -Force | Out-Null
  Set-ItemProperty -Path $Tvk -Name 'AllowLoopback' -Value 1 -Type DWord
  Set-ItemProperty -Path $Tvk -Name 'LoopbackOnly' -Value 1 -Type DWord
  Restart-Service tvnserver -Force -ErrorAction SilentlyContinue
}
# Túnel como tarea programada del sistema
$action = New-ScheduledTaskAction -Execute $Frpc -Argument "-c \`"$Dir\frpc.toml\`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$sys = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Unregister-ScheduledTask -TaskName 'FleetControl Tunnel' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'FleetControl Tunnel' -Action $action -Trigger $trigger -Settings $settings -Principal $sys | Out-Null
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
Start-ScheduledTask -TaskName 'FleetControl Tunnel'
"Acceso remoto listo: VNC activo y túnel en el puerto $Port"
`;
    }
    case 'disable_remote':
      return `# FleetControl · desactivar acceso remoto
$ErrorActionPreference = 'Continue'
Unregister-ScheduledTask -TaskName 'FleetControl Tunnel' -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item (Join-Path $env:ProgramData 'FleetControl\\tunnel') -Recurse -Force -ErrorAction SilentlyContinue
$Tvn = Join-Path $env:ProgramFiles 'TightVNC\\tvnserver.exe'
if (Test-Path $Tvn) { & $Tvn -controlservice -shutdown | Out-Null; Start-Sleep -Seconds 1 }
$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$app = Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*TightVNC*' } | Select-Object -First 1
if ($app) { $p = Start-Process msiexec.exe -ArgumentList "/x $($app.PSChildName) /quiet /norestart" -Wait -PassThru; "TightVNC desinstalado ($($p.ExitCode))" }
"Acceso remoto desactivado"
`;
    case 'list_software':
      return `$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Sort-Object DisplayName -Unique | ForEach-Object { "$($_.DisplayName)\`t$($_.DisplayVersion)" }
`;
    case 'run_script':
      return p.win_script && p.win_script.trim() ? p.win_script : null;
    case 'message':
      return `msg.exe * /TIME:600 ${psq(p.title + ': ' + p.text)}\n"Mensaje enviado"\n`;
    case 'restart':
    case 'shutdown':
      return `shutdown.exe ${type === 'restart' ? '/r' : '/s'} /t ${p.delay_min * 60} /c ${psq('TI: el equipo se ' + (type === 'restart' ? 'reiniciará' : 'apagará') + ' en ' + p.delay_min + ' min. Guarda tu trabajo.')}
"${type === 'restart' ? 'Reinicio' : 'Apagado'} programado en ${p.delay_min} min"
`;
    case 'update_agent':
      return `$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$d = Join-Path $env:ProgramData 'FleetControl'
Invoke-WebRequest -Uri ${psq(ctx.serverUrl + '/agent/windows/agent.ps1')} -OutFile "$d\\agent.ps1.new" -UseBasicParsing
Move-Item "$d\\agent.ps1.new" "$d\\agent.ps1" -Force
"Agente actualizado"
`;
    case 'remove_agent':
      return `New-Item -ItemType File -Force -Path (Join-Path $env:ProgramData 'FleetControl\\.remove') | Out-Null
"El agente se desinstalará al terminar este ciclo."
`;
    default:
      return null;
  }
}

function build(type, payload, device, ctx) {
  return device.platform === 'macos' ? buildMac(type, payload, ctx) : buildWin(type, payload, ctx);
}

/** Script de limpieza de cookies y sesiones que acompaña al cierre de sesión de Google. */
const GOOGLE_LOCAL_CLEANUP = {
  browsers: ['chrome', 'edge', 'brave', 'firefox', 'safari'],
  items: ['cookies', 'sessions', 'accounts'],
  user: '',
  close_browsers: true,
};

module.exports = { TYPES, FILE_PRESETS, prepare, build, ValidationError, GOOGLE_LOCAL_CLEANUP };
