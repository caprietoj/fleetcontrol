'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const {
  db, sha256, randomToken, hashPassword, verifyPassword, getSetting, setSetting, audit, bootstrap,
} = require('./db');
const cmds = require('./scripts/commands');
const google = require('./google');
const ipad = require('./ipad');
const QRCode = require('qrcode');

bootstrap();

const PORT = parseInt(process.env.PORT || '8080', 10);
const ONLINE_WINDOW_SEC = 180;
const SESSION_HOURS = 12;
const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');
const AGENT_VERSION = '1.0.0';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const serverUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const clientIp = (req) => req.ip;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// =====================================================================
//  Archivos públicos: panel, agentes e instaladores
// =====================================================================
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.get('/agent/macos/agent.sh', (req, res) => {
  res.type('text/plain').send(fs.readFileSync(path.join(AGENTS_DIR, 'macos', 'agent.sh'), 'utf8'));
});
app.get('/agent/windows/agent.ps1', (req, res) => {
  res.type('text/plain').send(fs.readFileSync(path.join(AGENTS_DIR, 'windows', 'agent.ps1'), 'utf8'));
});
app.get('/install/macos.sh', (req, res) => {
  const t = fs.readFileSync(path.join(AGENTS_DIR, 'macos', 'install.sh'), 'utf8');
  res.type('text/plain').send(t.replaceAll('__SERVER_URL__', serverUrl(req)));
});
app.get('/install/windows.ps1', (req, res) => {
  const t = fs.readFileSync(path.join(AGENTS_DIR, 'windows', 'install.ps1'), 'utf8');
  res.type('text/plain').send(t.replaceAll('__SERVER_URL__', serverUrl(req)));
});

// ---------- marca institucional ----------
const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
const BRAND = {
  name: process.env.BRAND_NAME || 'The Victoria School',
  product: process.env.BRAND_PRODUCT || 'Gestión de equipos TI',
  primary: hex(process.env.BRAND_PRIMARY, '#0b2a55'),
  accent: hex(process.env.BRAND_ACCENT, '#1d5fb8'),
  logo: process.env.BRAND_LOGO_URL ?? 'https://thevictoriaschool.edu.co/static/pix/logo-horizontal.a36e643498d0.png',
  site: process.env.BRAND_SITE || 'https://thevictoriaschool.edu.co/',
};
app.get('/api/brand', (req, res) => res.json(BRAND));

// ---------- inscripción de iPad (perfil OTA) ----------
// Flujo: QR → página /enroll/ipad/<token> → descarga del perfil "Profile Service" →
// el iPad envía sus datos a /enroll/ipad/profile-service → el servidor responde con
// una redirección 301 a una página de confirmación (método más compatible con iPadOS).
function ipadPage(res, status, title, body, ok = false) {
  const color = ok ? '#12805c' : status >= 400 ? '#c62828' : BRAND.primary;
  res.status(status).type('text/html').send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · ${esc(BRAND.name)}</title>
<style>body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#f4f5f7;color:#16181d}
header{background:${BRAND.primary};color:#fff;padding:18px 22px;font-weight:700}
main{max-width:560px;margin:22px auto;padding:0 18px}.card{background:#fff;border-radius:14px;padding:22px;border-top:5px solid ${color}}
h1{font-size:22px;color:${color};margin:0 0 10px}ol{padding-left:20px;line-height:1.6}
.btn{display:block;text-align:center;background:${BRAND.accent};color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:600;font-size:17px;margin:16px 0}
.warn{background:#fdecec;border:1px solid #f5c2c2;color:#8e1b1b;padding:12px;border-radius:10px;font-size:14px}
small{color:#6b7280}</style></head><body><header>${esc(BRAND.name)} · ${esc(BRAND.product)}</header>
<main><div class="card"><h1>${esc(title)}</h1>${body}</div></main></body></html>`);
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tokenOk = (t) => typeof t === 'string' && sha256(t) === sha256(getSetting('enrollment_token'));
const isHttps = (req) => serverUrl(req).startsWith('https://');

app.get('/enroll/ipad/ok/:id', (req, res) => {
  const d = db.prepare("SELECT hostname, serial, model FROM devices WHERE id = ? AND platform = 'ipados'").get(req.params.id);
  if (!d) return ipadPage(res, 404, 'Registro no encontrado', '<p>Vuelve a escanear el código QR.</p>');
  ipadPage(res, 200, '✓ iPad registrado', `<p>Este iPad quedó registrado en el inventario de TI.</p>
    <p><b>Modelo:</b> ${esc(d.model)}<br><b>Número de serie:</b> ${esc(d.serial || '—')}</p>
    <p><small>Ya puedes cerrar esta página. No queda ningún perfil instalado en el iPad.</small></p>`, true);
});

app.get('/enroll/ipad/error', (req, res) => {
  const reasons = {
    token: 'El código QR ya no es válido (el token de registro fue renovado). Pide a TI un código nuevo y elimina el perfil descargado en Ajustes → General → VPN y gestión de dispositivos.',
    datos: 'El iPad no envió sus datos en un formato reconocible.',
    servidor: 'Ocurrió un error en el servidor al guardar el registro.',
  };
  ipadPage(res, 400, 'No se pudo registrar el iPad', `<p>${esc(reasons[req.query.motivo] || reasons.datos)}</p>`);
});

app.get('/enroll/ipad/:token', (req, res) => {
  if (!tokenOk(req.params.token)) {
    return ipadPage(res, 403, 'Enlace no válido o vencido', '<p>Pide a TI un código QR nuevo.</p>');
  }
  const https = isHttps(req);
  ipadPage(res, 200, 'Registrar este iPad', `
    ${https ? '' : `<div class="warn"><b>Este servidor no usa HTTPS.</b> iPadOS mostrará “Ocurrió un error desconocido” al instalar el perfil.
      TI debe publicar el panel con un dominio y certificado HTTPS (ver README) o registrar este iPad manualmente.</div>`}
    <ol>
      <li>Toca <b>Descargar perfil</b> y luego <b>Permitir</b>.</li>
      <li>Abre <b>Ajustes</b> → <b>Perfil descargado</b> (arriba) → <b>Instalar</b> e ingresa el código del iPad.</li>
      <li>Al terminar, Safari mostrará “iPad registrado”.</li>
    </ol>
    <a class="btn" href="/enroll/ipad/${esc(req.params.token)}/registro.mobileconfig">Descargar perfil</a>
    <p><small>El perfil solo envía a TI el número de serie, el modelo, la versión de iPadOS y el identificador del equipo. No instala nada ni da control sobre el iPad.</small></p>`);
});

app.get('/enroll/ipad/:token/registro.mobileconfig', (req, res) => {
  if (!tokenOk(req.params.token)) return ipadPage(res, 403, 'Enlace no válido o vencido', '<p>Pide a TI un código QR nuevo.</p>');
  const xml = ipad.enrollmentProfile({ serverUrl: serverUrl(req), token: getSetting('enrollment_token'), orgName: BRAND.name });
  res.set('Content-Type', 'application/x-apple-aspen-config');
  res.set('Content-Disposition', 'attachment; filename="registro-ipad.mobileconfig"');
  res.set('Cache-Control', 'no-store');
  res.end(Buffer.from(xml, 'utf8'));
});

app.post('/enroll/ipad/profile-service', express.raw({ type: () => true, limit: '512kb' }), (req, res) => {
  const base = serverUrl(req);
  const bytes = Buffer.isBuffer(req.body) ? req.body.length : 0;
  const a = ipad.parseDeviceAttributes(req.body);
  console.log(`[ipad] solicitud de ${clientIp(req)}: ${bytes} bytes, content-type=${req.get('content-type')}, atributos=${a ? Object.keys(a).join(',') : 'ninguno'}`);
  if (!a || !(a.SERIAL || a.UDID)) {
    audit('ipad', 'enrolamiento_fallido', null, { motivo: 'datos', bytes, contentType: req.get('content-type') }, clientIp(req));
    return res.redirect(301, `${base}/enroll/ipad/error?motivo=datos`);
  }
  if (!tokenOk(a.CHALLENGE)) {
    audit('ipad', 'enrolamiento_rechazado', a.SERIAL, { motivo: 'token' }, clientIp(req));
    return res.redirect(301, `${base}/enroll/ipad/error?motivo=token`);
  }
  try {
    const serial = str(a.SERIAL, 40);
    const udid = str(a.UDID, 80);
    const row = db.prepare("SELECT id FROM devices WHERE platform = 'ipados' AND ((serial IS NOT NULL AND serial = ?) OR (udid IS NOT NULL AND udid = ?))").get(serial, udid);
    const id = row ? row.id : crypto.randomUUID();
    if (!row) {
      db.prepare("INSERT INTO devices(id, token_hash, platform, enroll_method) VALUES(?,?, 'ipados', 'profile')").run(id, sha256(randomToken()));
    }
    const name = a.DEVICE_NAME && a.DEVICE_NAME !== 'iPad' ? a.DEVICE_NAME : `iPad ${serial || ''}`.trim();
    db.prepare(`UPDATE devices SET hostname = COALESCE(hostname, ?), serial = ?, udid = ?, imei = ?, manufacturer = 'Apple', model = ?, os_version = ?,
                status = 'active', enroll_method = 'profile', last_seen = ? WHERE id = ?`)
      .run(str(name), serial, udid, str(a.IMEI, 40) || null, ipad.modelName(a.PRODUCT), a.VERSION ? `iPadOS (build ${str(a.VERSION, 20)})` : null, nowSql(), id);
    audit('ipad', row ? 'reenrolado' : 'enrolado', `${name} (${serial || 's/n'})`, { product: a.PRODUCT }, clientIp(req));
    res.redirect(301, `${base}/enroll/ipad/ok/${id}`);
  } catch (e) {
    console.error('[ipad] error guardando registro', e);
    res.redirect(301, `${base}/enroll/ipad/error?motivo=servidor`);
  }
});

// =====================================================================
//  API del agente
// =====================================================================
const agentApi = express.Router();
agentApi.use(express.json({ limit: '256kb' }));
agentApi.use(express.text({ limit: '1mb', type: 'text/*' }));

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v, n = 200) => (v === undefined || v === null ? null : String(v).slice(0, n));

function inventoryFields(b) {
  let accounts = b.google_accounts;
  if (typeof accounts === 'string') accounts = accounts.split(/[\s,]+/);
  accounts = Array.isArray(accounts)
    ? [...new Set(accounts.map((a) => String(a).trim().toLowerCase()).filter((a) => /@/.test(a)))].slice(0, 50)
    : [];
  return {
    hostname: str(b.hostname), serial: str(b.serial), manufacturer: str(b.manufacturer), model: str(b.model),
    os_version: str(b.os_version), cpu: str(b.cpu), ram_gb: num(b.ram_gb), disk_total_gb: num(b.disk_total_gb),
    disk_free_gb: num(b.disk_free_gb), ip: str(b.ip), logged_user: str(b.logged_user),
    google_accounts: JSON.stringify(accounts), agent_version: str(b.agent_version, 20),
  };
}

agentApi.post('/enroll', (req, res) => {
  const b = req.body || {};
  const expected = getSetting('enrollment_token');
  if (!b.token || typeof b.token !== 'string' || sha256(b.token) !== sha256(expected)) {
    audit('agente', 'enrolamiento_rechazado', b.hostname, null, clientIp(req));
    return res.status(403).type('text/plain').send('ERROR=token de enrolamiento inválido\n');
  }
  const platform = b.platform === 'macos' ? 'macos' : b.platform === 'windows' ? 'windows' : null;
  if (!platform) return res.status(400).type('text/plain').send('ERROR=plataforma no soportada\n');

  const inv = inventoryFields(b);
  const token = randomToken(32);
  let existing = inv.serial
    ? db.prepare('SELECT id FROM devices WHERE serial = ? AND platform = ?').get(inv.serial, platform)
    : null;
  let id;
  if (existing) {
    id = existing.id;
    db.prepare("UPDATE devices SET token_hash = ?, status = 'active', last_seen = ? WHERE id = ?").run(sha256(token), nowSql(), id);
  } else {
    id = crypto.randomUUID();
    db.prepare('INSERT INTO devices(id, token_hash, platform, last_seen) VALUES(?,?,?,?)').run(id, sha256(token), platform, nowSql());
  }
  const sets = Object.keys(inv).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE devices SET ${sets} WHERE id = ?`).run(...Object.values(inv), id);
  audit('agente', existing ? 'reenrolado' : 'enrolado', `${inv.hostname} (${inv.serial || 's/n'})`, { platform }, clientIp(req));
  res.type('text/plain').send(`DEVICE_ID=${id}\nDEVICE_TOKEN=${token}\n`);
});

function deviceAuth(req, res, next) {
  const id = req.get('X-Device-Id');
  const token = req.get('X-Device-Token');
  if (!id || !token) return res.status(401).type('text/plain').send('ERROR=sin credenciales\n');
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!d || d.status === 'retired') return res.status(401).type('text/plain').send('ERROR=dispositivo no registrado\n');
  const a = Buffer.from(d.token_hash, 'hex');
  const b = Buffer.from(sha256(token), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).type('text/plain').send('ERROR=token inválido\n');
  req.device = d;
  next();
}

agentApi.post('/checkin', deviceAuth, (req, res) => {
  const inv = inventoryFields(req.body || {});
  const keys = Object.keys(inv).filter((k) => inv[k] !== null);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE devices SET ${sets ? sets + ', ' : ''}last_seen = ? WHERE id = ?`)
    .run(...keys.map((k) => inv[k]), nowSql(), req.device.id);
  const pending = db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status = 'pending'").get(req.device.id).n;
  res.type('text/plain').send(`OK\nPENDING=${pending}\nSERVER_AGENT_VERSION=${AGENT_VERSION}\n`);
});

agentApi.get('/next', deviceAuth, (req, res) => {
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowSql(), req.device.id);
  const c = db.prepare("SELECT id, script FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(req.device.id);
  if (!c) return res.status(204).end();
  db.prepare("UPDATE commands SET status = 'running', sent_at = ? WHERE id = ?").run(nowSql(), c.id);
  res.set('X-Command-Id', String(c.id)).type('text/plain').send(c.script);
});

agentApi.post('/result/:id', deviceAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT * FROM commands WHERE id = ? AND device_id = ?').get(id, req.device.id);
  if (!c) return res.status(404).type('text/plain').send('ERROR=comando no encontrado\n');
  const exit = parseInt(req.get('X-Exit-Code') || '0', 10);
  let output = typeof req.body === 'string' ? req.body : '';
  if (output.length > 200_000) output = output.slice(0, 200_000) + '\n…(salida truncada)';
  const status = exit === 0 ? 'success' : 'failed';
  db.prepare('UPDATE commands SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ?')
    .run(status, exit, output, nowSql(), id);
  if (c.type === 'remove_agent' && status === 'success') {
    db.prepare("UPDATE devices SET status = 'retired' WHERE id = ?").run(req.device.id);
  }
  res.type('text/plain').send('OK\n');
});

app.use('/api/agent', agentApi);

// =====================================================================
//  API de administración
// =====================================================================
const adminApi = express.Router();
adminApi.use(express.json({ limit: '512kb' }));

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const loginAttempts = new Map();
adminApi.post('/login', (req, res) => {
  const ip = clientIp(req);
  const a = loginAttempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const { username, password } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
  if (!admin || !verifyPassword(String(password || ''), admin.password_hash)) {
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60_000; a.n = 0; }
    loginAttempts.set(ip, a);
    audit(username, 'login_fallido', null, null, ip);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  loginAttempts.delete(ip);
  const token = randomToken(32);
  const exp = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash, admin_id, expires_at) VALUES(?,?,?)').run(sha256(token), admin.id, exp);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `fc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  audit(admin.username, 'login', null, null, ip);
  res.json({ username: admin.username });
});

function adminAuth(req, res, next) {
  const token = parseCookies(req).fc_session;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  const s = db.prepare(`SELECT s.*, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id
                        WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), new Date().toISOString());
  if (!s) return res.status(401).json({ error: 'Sesión expirada' });
  // Protección CSRF adicional: las peticiones que modifican exigen JSON desde el panel
  if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Se requiere JSON' });
  req.admin = { id: s.admin_id, username: s.username };
  req.sessionHash = s.token_hash;
  next();
}

adminApi.use(adminAuth);
const actor = (req) => req.admin.username;

adminApi.post('/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  res.setHeader('Set-Cookie', 'fc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
adminApi.get('/me', (req, res) => res.json({ username: req.admin.username }));

// ---------- dispositivos ----------
const ONLINE_SQL = `(d.last_seen IS NOT NULL AND (strftime('%s','now') - strftime('%s', d.last_seen)) < ${ONLINE_WINDOW_SEC})`;
function deviceRow(d) {
  return { ...d, token_hash: undefined, google_accounts: JSON.parse(d.google_accounts || '[]'), online: d.platform !== 'ipados' && Boolean(d.online) };
}

adminApi.get('/devices', (req, res) => {
  const rows = db.prepare(`SELECT d.*, ${ONLINE_SQL} AS online,
      (SELECT COUNT(*) FROM commands c WHERE c.device_id = d.id AND c.status IN ('pending','running')) AS pending
    FROM devices d ORDER BY d.status = 'retired', d.hostname COLLATE NOCASE`).all();
  res.json(rows.map(deviceRow));
});

adminApi.get('/devices/:id', (req, res) => {
  const d = db.prepare(`SELECT d.*, ${ONLINE_SQL} AS online FROM devices d WHERE id = ?`).get(req.params.id);
  if (!d) throw new HttpError(404, 'Dispositivo no encontrado');
  const commands = db.prepare(`SELECT id, type, summary, status, exit_code, created_by, created_at, finished_at
    FROM commands WHERE device_id = ? ORDER BY id DESC LIMIT 100`).all(d.id);
  const sw = db.prepare(`SELECT output, finished_at FROM commands WHERE device_id = ? AND type = 'list_software'
    AND status = 'success' ORDER BY id DESC LIMIT 1`).get(d.id);
  res.json({ device: deviceRow(d), commands, software: sw || null });
});

adminApi.patch('/devices/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) throw new HttpError(404, 'Dispositivo no encontrado');
  const b = req.body || {};
  const g = b.google_email !== undefined ? String(b.google_email).trim().toLowerCase() : d.google_email;
  if (g && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(g)) throw new HttpError(400, 'Correo no válido');
  if (d.platform === 'ipados' && b.assigned_to !== undefined) {
    db.prepare('UPDATE devices SET logged_user = ? WHERE id = ?').run(String(b.assigned_to).trim().slice(0, 100) || null, d.id);
  }
  db.prepare('UPDATE devices SET group_name = ?, notes = ?, google_email = ? WHERE id = ?').run(
    b.group_name !== undefined ? (String(b.group_name).trim().slice(0, 60) || null) : d.group_name,
    b.notes !== undefined ? String(b.notes).slice(0, 2000) : d.notes,
    g || null, d.id,
  );
  audit(actor(req), 'dispositivo_editado', d.hostname, b, clientIp(req));
  res.json({ ok: true });
});

adminApi.post('/devices/bulk-group', (req, res) => {
  const ids = Array.isArray(req.body.device_ids) ? req.body.device_ids : [];
  const group = String(req.body.group_name || '').trim().slice(0, 60) || null;
  const stmt = db.prepare('UPDATE devices SET group_name = ? WHERE id = ?');
  ids.forEach((id) => stmt.run(group, id));
  audit(actor(req), 'grupo_asignado', group, { count: ids.length }, clientIp(req));
  res.json({ ok: true });
});

adminApi.delete('/devices/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) throw new HttpError(404, 'Dispositivo no encontrado');
  db.prepare('DELETE FROM devices WHERE id = ?').run(d.id);
  audit(actor(req), 'dispositivo_eliminado', d.hostname, { serial: d.serial }, clientIp(req));
  res.json({ ok: true });
});

// ---------- acciones / comandos ----------
const getPackage = (id) => db.prepare('SELECT * FROM packages WHERE id = ?').get(parseInt(id, 10));

async function googleSignoutForDevice(device, payload) {
  const st = google.status();
  const detected = JSON.parse(device.google_accounts || '[]').filter(google.isManagedEmail);
  const emails = [...new Set([device.google_email, ...detected, ...payload.extra_emails].filter(Boolean))];
  if (!st.configured) return { ok: false, output: 'Google Workspace no está configurado en el servidor (ver README).' };
  if (!emails.length) return { ok: false, output: 'No hay cuentas de Google asociadas a este equipo. Asigna un correo en la ficha del dispositivo.' };
  const lines = [];
  let ok = true;
  for (const e of emails) {
    try {
      await google.signOut(e);
      lines.push(`OK  ${e}: sesiones cerradas en todos los dispositivos`);
      if (payload.revoke_tokens) {
        const n = await google.revokeTokens(e);
        lines.push(`OK  ${e}: ${n} accesos de aplicaciones revocados`);
      }
    } catch (err) {
      ok = false;
      lines.push(`ERR ${e}: ${err.message}`);
    }
  }
  return { ok, output: lines.join('\n') };
}

adminApi.post('/commands', wrap(async (req, res) => {
  const { type, payload: raw } = req.body || {};
  const ids = Array.isArray(req.body.device_ids) ? [...new Set(req.body.device_ids)] : [];
  if (!cmds.TYPES[type]) throw new HttpError(400, 'Acción desconocida');
  if (!ids.length) throw new HttpError(400, 'Selecciona al menos un equipo');

  let prepared;
  try { prepared = cmds.prepare(type, raw, { getPackage }); }
  catch (e) { if (e instanceof cmds.ValidationError) throw new HttpError(400, e.message); throw e; }

  const ctx = { serverUrl: serverUrl(req) };
  const batch = randomToken(8);
  const insert = db.prepare(`INSERT INTO commands(batch_id, device_id, type, summary, payload, script, status, output, created_by, finished_at)
                             VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const result = { batch_id: batch, queued: 0, skipped: 0, done: 0, failed: 0 };

  for (const id of ids) {
    const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!d || d.status === 'retired') continue;

    if (type === 'google_signout') {
      const r = await googleSignoutForDevice(d, prepared.payload);
      insert.run(batch, d.id, type, prepared.summary, JSON.stringify(prepared.payload), null,
        r.ok ? 'success' : 'failed', r.output, actor(req), nowSql());
      r.ok ? result.done++ : result.failed++;
      if (prepared.payload.clear_cookies && d.platform !== 'ipados') {
        const script = cmds.build('clean_browsers', cmds.GOOGLE_LOCAL_CLEANUP, d, ctx);
        insert.run(batch, d.id, 'clean_browsers', 'cookies, sesiones y cuentas · todos los navegadores (tras cierre de sesión Google)',
          JSON.stringify(cmds.GOOGLE_LOCAL_CLEANUP), script, 'pending', null, actor(req), null);
        result.queued++;
      }
      continue;
    }

    if (d.platform === 'ipados') {
      insert.run(batch, d.id, type, prepared.summary, JSON.stringify(prepared.payload), null, 'skipped',
        'Los iPad no ejecutan esta acción: requieren un MDM de Apple (certificado APNs). En iPad solo aplica "Cerrar sesiones de Google".',
        actor(req), nowSql());
      result.skipped++;
      continue;
    }
    const script = cmds.build(type, prepared.payload, d, ctx);
    if (!script) {
      insert.run(batch, d.id, type, prepared.summary, JSON.stringify(prepared.payload), null, 'skipped',
        `No se indicó nada para ${d.platform === 'macos' ? 'macOS' : 'Windows'} en esta acción.`, actor(req), nowSql());
      result.skipped++;
      continue;
    }
    insert.run(batch, d.id, type, prepared.summary, JSON.stringify(prepared.payload), script, 'pending', null, actor(req), null);
    result.queued++;
  }
  audit(actor(req), `accion:${type}`, `${ids.length} equipos`, { summary: prepared.summary, batch }, clientIp(req));
  res.json(result);
}));

adminApi.get('/commands', (req, res) => {
  const where = [];
  const args = [];
  if (req.query.device_id) { where.push('c.device_id = ?'); args.push(req.query.device_id); }
  if (req.query.batch_id) { where.push('c.batch_id = ?'); args.push(req.query.batch_id); }
  if (req.query.status) { where.push('c.status = ?'); args.push(req.query.status); }
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  const rows = db.prepare(`SELECT c.id, c.batch_id, c.device_id, c.type, c.summary, c.status, c.exit_code, c.created_by,
      c.created_at, c.sent_at, c.finished_at, d.hostname, d.platform
    FROM commands c LEFT JOIN devices d ON d.id = c.device_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.id DESC LIMIT ${limit}`).all(...args);
  res.json(rows);
});

adminApi.get('/commands/:id', (req, res) => {
  const c = db.prepare(`SELECT c.*, d.hostname, d.platform FROM commands c LEFT JOIN devices d ON d.id = c.device_id WHERE c.id = ?`)
    .get(parseInt(req.params.id, 10));
  if (!c) throw new HttpError(404, 'Comando no encontrado');
  res.json(c);
});

adminApi.post('/commands/:id/cancel', (req, res) => {
  const r = db.prepare("UPDATE commands SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'")
    .run(nowSql(), parseInt(req.params.id, 10));
  if (!r.changes) throw new HttpError(400, 'Solo se pueden cancelar comandos pendientes');
  audit(actor(req), 'comando_cancelado', req.params.id, null, clientIp(req));
  res.json({ ok: true });
});

// ---------- catálogo de software ----------
const KINDS = { macos: ['pkg', 'dmg', 'zip'], windows: ['msi', 'exe', 'winget'] };
adminApi.get('/packages', (req, res) => res.json(db.prepare('SELECT * FROM packages ORDER BY platform, name COLLATE NOCASE').all()));
adminApi.post('/packages', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 100);
  const platform = b.platform;
  const kind = b.kind;
  const source = String(b.source || '').trim();
  const sha = String(b.sha256 || '').trim().toLowerCase();
  if (!name) throw new HttpError(400, 'Nombre requerido');
  if (!KINDS[platform] || !KINDS[platform].includes(kind)) throw new HttpError(400, 'Tipo de paquete no válido para la plataforma');
  if (kind === 'winget') {
    if (!/^[\w.\-+]+$/.test(source)) throw new HttpError(400, 'ID de winget no válido (ej. Google.Chrome)');
  } else if (!/^https:\/\/\S+$/i.test(source)) throw new HttpError(400, 'La URL de descarga debe empezar por https://');
  if (sha && !/^[a-f0-9]{64}$/.test(sha)) throw new HttpError(400, 'SHA-256 no válido');
  const args = String(b.args || '').slice(0, 500);
  if (/[`$;|&<>\n\r]/.test(args)) throw new HttpError(400, 'Los argumentos contienen caracteres no permitidos');
  const r = db.prepare('INSERT INTO packages(name, platform, kind, source, args, sha256) VALUES(?,?,?,?,?,?)')
    .run(name, platform, kind, source, args, sha || null);
  audit(actor(req), 'paquete_creado', name, { platform, kind, source }, clientIp(req));
  res.json({ id: Number(r.lastInsertRowid) });
});
adminApi.delete('/packages/:id', (req, res) => {
  const p = getPackage(req.params.id);
  if (!p) throw new HttpError(404, 'Paquete no encontrado');
  db.prepare('DELETE FROM packages WHERE id = ?').run(p.id);
  audit(actor(req), 'paquete_eliminado', p.name, null, clientIp(req));
  res.json({ ok: true });
});

// ---------- Google directo (sin equipo) ----------
adminApi.post('/google/signout', wrap(async (req, res) => {
  const emails = (req.body.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  if (!emails.length) throw new HttpError(400, 'Escribe al menos un correo');
  const fake = { google_email: null, google_accounts: '[]' };
  const r = await googleSignoutForDevice(fake, { extra_emails: emails, revoke_tokens: Boolean(req.body.revoke_tokens) });
  audit(actor(req), 'google_signout', emails.join(', '), { ok: r.ok }, clientIp(req));
  res.json(r);
}));

// ---------- configuración ----------
adminApi.get('/settings', wrap(async (req, res) => {
  const url = serverUrl(req);
  const token = getSetting('enrollment_token');
  const ipadUrl = `${url}/enroll/ipad/${token}`;
  res.json({
    enroll_ipad_url: ipadUrl,
    enroll_ipad_qr: await QRCode.toString(ipadUrl, { type: 'svg', margin: 1, color: { dark: BRAND.primary, light: '#ffffff' } }),
    server_url: url,
    enrollment_token: token,
    install_macos: `curl -fsSL ${url}/install/macos.sh | sudo bash -s -- ${token}`,
    install_windows: `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${url}/install/windows.ps1))) -Token ${token}"`,
    google: google.status(),
    types: cmds.TYPES,
    file_presets: Object.fromEntries(Object.entries(cmds.FILE_PRESETS).map(([k, v]) => [k, v.label])),
    agent_version: AGENT_VERSION,
    insecure: !url.startsWith('https://') && !/localhost|127\.0\.0\.1/.test(url),
  });
}));

// Registro manual de iPad (sin perfil)
adminApi.post('/ipads', (req, res) => {
  const b = req.body || {};
  const serial = String(b.serial || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8,14}$/.test(serial)) throw new HttpError(400, 'Número de serie no válido (8 a 14 letras y números)');
  if (db.prepare("SELECT 1 FROM devices WHERE platform = 'ipados' AND serial = ?").get(serial)) throw new HttpError(400, 'Ya existe un iPad con ese número de serie');
  const email = String(b.google_email || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Correo no válido');
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices(id, token_hash, platform, enroll_method, hostname, serial, manufacturer, model, os_version,
              logged_user, google_email, group_name, notes, last_seen) VALUES(?,?,'ipados','manual',?,?,'Apple',?,?,?,?,?,?,NULL)`)
    .run(id, sha256(randomToken()), String(b.name || `iPad ${serial}`).slice(0, 100), serial,
      String(b.model || 'iPad (7.ª generación)').slice(0, 100), b.os_version ? `iPadOS ${String(b.os_version).slice(0, 20)}` : null,
      String(b.assigned_to || '').slice(0, 100) || null, email || null, String(b.group_name || '').trim().slice(0, 60) || null,
      String(b.notes || '').slice(0, 2000) || null);
  audit(actor(req), 'ipad_registrado_manual', serial, null, clientIp(req));
  res.json({ id });
});
adminApi.post('/settings/rotate-token', (req, res) => {
  setSetting('enrollment_token', randomToken(24));
  audit(actor(req), 'token_rotado', null, null, clientIp(req));
  res.json({ ok: true });
});

adminApi.get('/admins', (req, res) => res.json(db.prepare('SELECT id, username, created_at FROM admins ORDER BY id').all()));
adminApi.post('/admins', (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[\w.@-]{3,40}$/.test(String(username || ''))) throw new HttpError(400, 'Usuario no válido');
  if (String(password || '').length < 10) throw new HttpError(400, 'La contraseña debe tener al menos 10 caracteres');
  try { db.prepare('INSERT INTO admins(username, password_hash) VALUES(?,?)').run(username, hashPassword(password)); }
  catch { throw new HttpError(400, 'Ese usuario ya existe'); }
  audit(actor(req), 'admin_creado', username, null, clientIp(req));
  res.json({ ok: true });
});
adminApi.delete('/admins/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.admin.id) throw new HttpError(400, 'No puedes eliminar tu propio usuario');
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
  audit(actor(req), 'admin_eliminado', String(id), null, clientIp(req));
  res.json({ ok: true });
});
adminApi.post('/password', (req, res) => {
  const { current, next: nw } = req.body || {};
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
  if (!verifyPassword(String(current || ''), a.password_hash)) throw new HttpError(400, 'La contraseña actual no es correcta');
  if (String(nw || '').length < 10) throw new HttpError(400, 'La nueva contraseña debe tener al menos 10 caracteres');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(nw), a.id);
  db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?').run(a.id, req.sessionHash);
  audit(actor(req), 'password_cambiado', null, null, clientIp(req));
  res.json({ ok: true });
});

adminApi.get('/audit', (req, res) => {
  res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 300').all());
});

adminApi.get('/stats', (req, res) => {
  const r = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status != 'retired' AND platform != 'ipados' AND ${ONLINE_SQL.replaceAll('d.', '')} THEN 1 ELSE 0 END) AS online,
      SUM(CASE WHEN platform = 'ipados' AND status != 'retired' THEN 1 ELSE 0 END) AS ipados,
      SUM(CASE WHEN platform = 'macos' AND status != 'retired' THEN 1 ELSE 0 END) AS macos,
      SUM(CASE WHEN platform = 'windows' AND status != 'retired' THEN 1 ELSE 0 END) AS windows
    FROM devices`).get();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status IN ('pending','running')").get().n;
  const failed24 = db.prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'failed' AND finished_at > datetime('now','-1 day')").get().n;
  res.json({ ...r, pending, failed24 });
});

app.use('/api', adminApi);

// ---------- errores ----------
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api/agent')) return res.status(status).type('text/plain').send(`ERROR=${err.message}\n`);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

// Comandos que se quedaron "en ejecución" demasiado tiempo
setInterval(() => {
  db.prepare(`UPDATE commands SET status = 'failed', output = COALESCE(output,'') || 'Tiempo de espera agotado (el agente no reportó resultado).',
              finished_at = ? WHERE status = 'running' AND sent_at < datetime('now','-2 hours')`).run(nowSql());
}, 5 * 60_000).unref();

app.listen(PORT, () => console.log(`FleetControl escuchando en http://localhost:${PORT}`));
