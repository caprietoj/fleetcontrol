#!/bin/bash
# FleetControl · agente para macOS
# Lo ejecuta launchd (com.fleetcontrol.agent) como root cada 60 segundos.
AGENT_VERSION="1.0.0"
DIR="/Library/Application Support/FleetControl"
CONF="$DIR/config"
LOG="$DIR/agent.log"
LOCK="$DIR/.lock"
MAX_RUNTIME=3600

[ -f "$CONF" ] || { echo "Falta $CONF" >&2; exit 1; }
# shellcheck disable=SC1090
. "$CONF"   # SERVER_URL, DEVICE_ID, DEVICE_TOKEN

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
# Rotación sencilla del log
[ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ] && mv -f "$LOG" "$LOG.1"

# Evitar ejecuciones simultáneas
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +90 2>/dev/null)" ]; then rm -rf "$LOCK"; mkdir "$LOCK" || exit 0; else exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

CURL=(curl -sS --connect-timeout 15 --max-time 120 -H "X-Device-Id: $DEVICE_ID" -H "X-Device-Token: $DEVICE_TOKEN")

jesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }

inventory() {
  local hw model serial os cpu ram disk_total disk_free ip user accounts
  hw=$(system_profiler SPHardwareDataType 2>/dev/null)
  model=$(echo "$hw" | awk -F': ' '/Model Name/{n=$2} /Model Identifier/{i=$2} END{print n" ("i")"}')
  serial=$(echo "$hw" | awk -F': ' '/Serial Number/{print $2; exit}')
  os="macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  cpu=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
  [ -z "$cpu" ] && cpu=$(echo "$hw" | awk -F': ' '/Chip|Processor Name/{print $2; exit}')
  ram=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  read -r disk_total disk_free < <(df -k / | awk 'NR==2{printf "%.1f %.1f", $2/1048576, $4/1048576}')
  # En APFS el espacio libre real se ve mejor en el volumen de datos
  [ -d /System/Volumes/Data ] && disk_free=$(df -k /System/Volumes/Data | awk 'NR==2{printf "%.1f", $4/1048576}')
  ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
  user=$(stat -f%Su /dev/console)
  # Cuentas de Google con sesión en Chrome/Edge/Brave
  accounts=$(for f in /Users/*/Library/Application\ Support/{Google/Chrome,Microsoft\ Edge,BraveSoftware/Brave-Browser}/Local\ State; do
      [ -f "$f" ] && grep -o '"user_name":"[^"]*@[^"]*"' "$f" | cut -d'"' -f4
    done 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//')
  cat <<EOF
{"platform":"macos","hostname":"$(jesc "$(scutil --get ComputerName 2>/dev/null || hostname)")","serial":"$(jesc "$serial")",
"manufacturer":"Apple","model":"$(jesc "$model")","os_version":"$(jesc "$os")","cpu":"$(jesc "$cpu")",
"ram_gb":"$ram","disk_total_gb":"$disk_total","disk_free_gb":"$disk_free","ip":"$(jesc "$ip")",
"logged_user":"$(jesc "$user")","google_accounts":"$(jesc "$accounts")","agent_version":"$AGENT_VERSION"}
EOF
}

# ---------- check-in ----------
RESP=$("${CURL[@]}" -X POST -H "Content-Type: application/json" --data-binary "$(inventory)" -w '\n%{http_code}' "$SERVER_URL/api/agent/checkin")
CODE=$(echo "$RESP" | tail -n1)
if [ "$CODE" != "200" ]; then log "check-in falló (HTTP $CODE): $(echo "$RESP" | head -n1)"; exit 0; fi

# ---------- ejecutar comandos pendientes ----------
TMP=$(mktemp -d /tmp/fcagent.XXXXXX)
trap 'rm -rf "$LOCK" "$TMP"' EXIT
for _ in $(seq 1 25); do
  CODE=$("${CURL[@]}" -D "$TMP/h" -o "$TMP/script" -w '%{http_code}' "$SERVER_URL/api/agent/next")
  [ "$CODE" = "200" ] || break
  CID=$(awk -F': ' 'tolower($1)=="x-command-id"{gsub("\r","",$2); print $2}' "$TMP/h")
  [ -n "$CID" ] || break
  log "Ejecutando comando $CID"
  chmod 700 "$TMP/script"
  if command -v perl >/dev/null; then
    perl -e 'alarm shift; exec @ARGV' "$MAX_RUNTIME" /bin/bash "$TMP/script" > "$TMP/out" 2>&1
  else
    /bin/bash "$TMP/script" > "$TMP/out" 2>&1
  fi
  RC=$?
  [ $RC -eq 142 ] && echo "Tiempo máximo de ejecución alcanzado (${MAX_RUNTIME}s)" >> "$TMP/out"
  "${CURL[@]}" -X POST -H "Content-Type: text/plain; charset=utf-8" -H "X-Exit-Code: $RC" \
    --data-binary "@$TMP/out" "$SERVER_URL/api/agent/result/$CID" >/dev/null || log "No se pudo enviar el resultado de $CID"
  log "Comando $CID terminó con código $RC"
done

# ---------- autodesinstalación ----------
if [ -f "$DIR/.remove" ]; then
  log "Desinstalando agente"
  rm -f /Library/LaunchDaemons/com.fleetcontrol.agent.plist
  rm -rf "$DIR"
  launchctl bootout system/com.fleetcontrol.agent 2>/dev/null
fi
exit 0
