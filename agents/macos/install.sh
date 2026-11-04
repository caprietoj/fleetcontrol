#!/bin/bash
# FleetControl · instalador del agente para macOS
# Uso:  curl -fsSL __SERVER_URL__/install/macos.sh | sudo bash -s -- TOKEN_DE_ENROLAMIENTO
set -e
SERVER_URL="__SERVER_URL__"
TOKEN="${1:-}"
DIR="/Library/Application Support/FleetControl"
PLIST="/Library/LaunchDaemons/com.fleetcontrol.agent.plist"

[ "$(id -u)" -eq 0 ] || { echo "Ejecuta con sudo."; exit 1; }
[ -n "$TOKEN" ] || { echo "Falta el token de enrolamiento."; exit 1; }

echo "→ Descargando agente desde $SERVER_URL"
mkdir -p "$DIR"; chmod 700 "$DIR"
curl -fsSL "$SERVER_URL/agent/macos/agent.sh" -o "$DIR/agent.sh"
bash -n "$DIR/agent.sh"
chmod 700 "$DIR/agent.sh"

SERIAL=$(system_profiler SPHardwareDataType | awk -F': ' '/Serial Number/{print $2; exit}')
NAME=$(scutil --get ComputerName 2>/dev/null || hostname)
MODEL=$(sysctl -n hw.model)

echo "→ Registrando el equipo $NAME ($SERIAL)"
RESP=$(curl -fsS -X POST -H "Content-Type: application/json" \
  --data-binary "{\"token\":\"$TOKEN\",\"platform\":\"macos\",\"hostname\":\"$NAME\",\"serial\":\"$SERIAL\",\"manufacturer\":\"Apple\",\"model\":\"$MODEL\"}" \
  "$SERVER_URL/api/agent/enroll") || { echo "El servidor rechazó el registro (¿token correcto?)."; exit 1; }
DEVICE_ID=$(echo "$RESP" | sed -n 's/^DEVICE_ID=//p')
DEVICE_TOKEN=$(echo "$RESP" | sed -n 's/^DEVICE_TOKEN=//p')
[ -n "$DEVICE_ID" ] && [ -n "$DEVICE_TOKEN" ] || { echo "Respuesta inesperada: $RESP"; exit 1; }

umask 077
cat > "$DIR/config" <<EOF
SERVER_URL="$SERVER_URL"
DEVICE_ID="$DEVICE_ID"
DEVICE_TOKEN="$DEVICE_TOKEN"
EOF

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fleetcontrol.agent</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/agent.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$DIR/agent.err</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"; chmod 644 "$PLIST"

launchctl bootout system/com.fleetcontrol.agent 2>/dev/null || true
launchctl bootstrap system "$PLIST"

echo ""
echo "✔ Agente instalado. El equipo aparecerá en el panel en menos de un minuto."
echo ""
echo "IMPORTANTE: para poder borrar cookies de Safari y archivos de Descargas/Escritorio/Documentos,"
echo "concede 'Acceso total al disco' a /bin/bash en Ajustes del Sistema → Privacidad y seguridad,"
echo "o despliega un perfil PPPC desde tu MDM (ver README)."
