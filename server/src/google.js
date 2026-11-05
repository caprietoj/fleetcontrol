'use strict';
// Integración con Google Workspace (Admin SDK Directory API).
// Usa una cuenta de servicio con delegación de dominio para:
//   - users.signOut  → cierra TODAS las sesiones web y de dispositivos del usuario
//   - tokens.delete  → revoca accesos OAuth de aplicaciones de terceros (opcional)
const fs = require('node:fs');
const crypto = require('node:crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.security',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
];

let cachedKey = null;
let cachedToken = null; // { token, exp }

function loadKey() {
  if (cachedKey) return cachedKey;
  const file = process.env.GOOGLE_SA_KEY_FILE;
  const inline = process.env.GOOGLE_SA_KEY_JSON;
  if (!file && !inline) return null;
  cachedKey = JSON.parse(inline || fs.readFileSync(file, 'utf8'));
  return cachedKey;
}

function allowedDomains() {
  return (process.env.GOOGLE_DOMAINS || '')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

function status() {
  let key = null;
  try { key = loadKey(); } catch (e) { return { configured: false, error: 'No se pudo leer la llave: ' + e.message }; }
  return {
    configured: Boolean(key && process.env.GOOGLE_ADMIN_EMAIL),
    serviceAccount: key ? key.client_email : null,
    adminEmail: process.env.GOOGLE_ADMIN_EMAIL || null,
    domains: allowedDomains(),
  };
}

function isManagedEmail(email) {
  const domains = allowedDomains();
  if (!domains.length) return true;
  const d = String(email).split('@')[1] || '';
  return domains.includes(d.toLowerCase());
}

async function getAccessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const key = loadKey();
  const admin = process.env.GOOGLE_ADMIN_EMAIL;
  if (!key || !admin) throw new Error('Google Workspace no está configurado (GOOGLE_SA_KEY_FILE y GOOGLE_ADMIN_EMAIL).');

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    sub: admin,
    scope: SCOPES.join(' '),
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');

  const res = await fetch(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Error obteniendo token de Google: ${data.error_description || data.error || res.status}`);
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function api(method, url) {
  const token = await getAccessToken();
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 204 || res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  const body = await res.json().catch(() => ({}));
  throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
}

const BASE = 'https://admin.googleapis.com/admin/directory/v1/users';

/** Cierra todas las sesiones del usuario (web, móviles, equipos). */
async function signOut(email) {
  await api('POST', `${BASE}/${encodeURIComponent(email)}/signOut`);
}

/** Revoca todos los tokens OAuth que el usuario dio a aplicaciones. */
async function revokeTokens(email) {
  const list = await api('GET', `${BASE}/${encodeURIComponent(email)}/tokens`);
  const items = (list && list.items) || [];
  for (const t of items) {
    await api('DELETE', `${BASE}/${encodeURIComponent(email)}/tokens/${encodeURIComponent(t.clientId)}`);
  }
  return items.length;
}

const DIR = 'https://admin.googleapis.com/admin/directory/v1';

/** Lista las unidades organizativas de Google Workspace (p. ej. "Estudiantes TVS"). */
async function listOrgUnits() {
  const data = await api('GET', `${DIR}/customer/my_customer/orgunits?type=all`);
  const items = (data && data.organizationUnits) || [];
  return items
    .map((o) => ({ orgUnitPath: o.orgUnitPath, name: o.name, parentOrgUnitPath: o.parentOrgUnitPath || null }))
    .sort((a, b) => a.orgUnitPath.localeCompare(b.orgUnitPath));
}

const normPath = (p) => String(p || '').replace(/\/+$/, '') || '/';
// Users.list no tiene un parámetro "orgUnitPath" propio: el filtro va dentro de "query",
// con su propio lenguaje de búsqueda. Los valores con espacios deben ir entre comillas.
const quoteQueryValue = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Lista los usuarios de una unidad organizativa exacta (no incluye subunidades hijas). */
async function listUsersInOrgUnit(orgUnitPath) {
  const users = [];
  let pageToken = '';
  do {
    const qs = new URLSearchParams({
      customer: 'my_customer', maxResults: '200', projection: 'basic', orderBy: 'email',
      query: `orgUnitPath=${quoteQueryValue(orgUnitPath)}`,
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await api('GET', `${DIR}/users?${qs}`);
    for (const u of (data && data.users) || []) {
      // Red de seguridad: si Google devolviera algo fuera de la unidad, se descarta aquí.
      if (u.orgUnitPath && normPath(u.orgUnitPath) !== normPath(orgUnitPath)) continue;
      users.push({ email: u.primaryEmail, name: (u.name && u.name.fullName) || u.primaryEmail, suspended: Boolean(u.suspended) });
    }
    pageToken = (data && data.nextPageToken) || '';
  } while (pageToken);
  return users;
}

module.exports = { status, signOut, revokeTokens, isManagedEmail, listOrgUnits, listUsersInOrgUnit };
