#!/bin/sh
set -eu
: "${FRP_TOKEN:?Falta FRP_TOKEN}"
START="${FRP_REMOTE_PORT_START:-41000}"
END="${FRP_REMOTE_PORT_END:-41099}"
cat > /etc/frps.toml <<CONF
bindPort = 7000
proxyBindAddr = "0.0.0.0"
maxPortsPerClient = 2
allowPorts = [{ start = ${START}, end = ${END} }]
auth.method = "token"
auth.token = "${FRP_TOKEN}"
log.level = "warn"
CONF
exec frps -c /etc/frps.toml
