import RFB from '/novnc/core/rfb.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('token');
const statusEl = $('#status');
const titleEl = $('#remoteTitle');
const screenEl = $('#screen');
let rfb = null;

function setStatus(text, ok = false) {
  statusEl.textContent = text;
  statusEl.classList.remove('hidden', 'ok');
  if (ok) statusEl.classList.add('ok');
}

async function main() {
  if (!token) throw new Error('Falta el token de la sesión remota.');
  const res = await fetch('/api/remote/session/' + encodeURIComponent(token), { cache: 'no-store' });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(info.error || 'La sesión remota no es válida.');
  titleEl.textContent = info.hostname || 'Equipo';
  document.title = `${info.hostname || 'Acceso remoto'} · FleetControl`;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${proto}://${location.host}/api/remote/vnc?token=${encodeURIComponent(token)}`;
  rfb = new RFB(screenEl, wsUrl, {
    shared: true,
    credentials: { password: info.password || '' },
    wsProtocols: ['binary'],
  });
  rfb.background = '#0b1020';
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.clipViewport = false;
  rfb.showDotCursor = true;
  rfb.focusOnClick = true;

  rfb.addEventListener('connect', () => {
    setStatus('Conectado', true);
    setTimeout(() => statusEl.classList.add('hidden'), 1800);
  });
  rfb.addEventListener('disconnect', (e) => {
    const reason = e.detail && e.detail.reason ? ` — ${e.detail.reason}` : '';
    setStatus('Desconectado' + reason);
  });
  rfb.addEventListener('credentialsrequired', () => {
    rfb.sendCredentials({ password: info.password || '' });
  });
  rfb.addEventListener('securityfailure', (e) => {
    setStatus('Falló la autenticación VNC' + (e.detail && e.detail.reason ? `: ${e.detail.reason}` : ''));
  });
}

$('#fullBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
});
$('#cadBtn').addEventListener('click', () => { if (rfb) rfb.sendCtrlAltDel(); });
$('#closeBtn').addEventListener('click', () => { if (rfb) rfb.disconnect(); else window.close(); });
window.addEventListener('beforeunload', () => { if (rfb) rfb.disconnect(); });

main().catch((e) => setStatus(e.message));
