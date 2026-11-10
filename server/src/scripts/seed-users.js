'use strict';
// Crea/actualiza los usuarios del panel FleetControl con su rol, guarda las
// credenciales en un .txt y envía un correo a cada persona.
//
// Uso:
//   node server/src/scripts/seed-users.js             (crea y envía correos)
//   node server/src/scripts/seed-users.js --no-email  (solo crea y escribe el .txt)
//   node server/src/scripts/seed-users.js --resend    (reenvía los correos usando el .txt)
//
// Variables opcionales:
//   CREDENTIALS_FILE  ruta del .txt (por defecto <DATA_DIR>/credenciales_usuarios.txt)
//   PUBLIC_URL        URL del panel que se incluye en el correo
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  db, DATA_DIR, hashPassword, isRole, roleInfo, permissionsFor, audit,
} = require('../db');
const mailer = require('../mailer');

const PANEL_URL = (process.env.PUBLIC_URL || 'https://registro.tvs.edu.co').replace(/\/+$/, '');
const SEND_EMAIL = !process.argv.includes('--no-email');

const USERS = [
  { username: 'aprendizsena@tvs.edu.co', name: 'Aprendiz SENA', role: 'aprendiz' },
  { username: 'aprendizsistemas@tvs.edu.co', name: 'Aprendiz de Sistemas', role: 'aprendiz' },
  { username: 'auxiliarsistemas@tvs.edu.co', name: 'Auxiliar de Sistemas', role: 'auxiliar' },
  { username: 'auxiliartic@tvs.edu.co', name: 'Auxiliar de TIC', role: 'auxiliar' },
  { username: 'jefesistemas@tvs.edu.co', name: 'Jefe de Sistemas', role: 'jefe' },
];

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%&*';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;
const pick = (s) => s[crypto.randomInt(s.length)];

function strongPassword(length = 16) {
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function emailBody(u, password) {
  const info = roleInfo(u.role);
  const perms = permissionsFor(u.role);
  const scope = perms.all
    ? 'Tendrás acceso completo al panel (dispositivos, software, cola, Google Workspace, registro de equipos y administración).'
    : 'Tu acceso permite únicamente <b>registrar equipos</b> y <b>cerrar las sesiones de Google Workspace de la organización Estudiantes Activos</b>.';
  const text = [
    `Hola, ${u.name}:`,
    '',
    'Se creó tu acceso al panel FleetControl de The Victoria School.',
    '',
    `Panel: ${PANEL_URL}`,
    `Usuario: ${u.username}`,
    `Contraseña temporal: ${password}`,
    `Rol: ${info.label}`,
    '',
    scope.replace(/<[^>]+>/g, ''),
    '',
    'Por seguridad, cambia la contraseña después del primer ingreso (Administradores → Cambiar mi contraseña).',
    'No compartas estas credenciales.',
    '',
    'Área de Sistemas · The Victoria School',
  ].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#16181d">
  <div style="background:#0b2a55;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
    <h2 style="margin:0;font-size:20px">FleetControl · The Victoria School</h2>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:0;padding:22px;border-radius:0 0 12px 12px">
    <p>Hola, <b>${u.name}</b>:</p>
    <p>Se creó tu acceso al panel de gestión de equipos TI.</p>
    <table style="border-collapse:collapse;width:100%;background:#f4f5f7;border-radius:10px">
      <tr><td style="padding:10px 14px;color:#6b7280">Panel</td><td style="padding:10px 14px"><a href="${PANEL_URL}">${PANEL_URL}</a></td></tr>
      <tr><td style="padding:10px 14px;color:#6b7280">Usuario</td><td style="padding:10px 14px"><b>${u.username}</b></td></tr>
      <tr><td style="padding:10px 14px;color:#6b7280">Contraseña temporal</td><td style="padding:10px 14px"><code style="font-size:15px">${password}</code></td></tr>
      <tr><td style="padding:10px 14px;color:#6b7280">Rol</td><td style="padding:10px 14px">${info.label}</td></tr>
    </table>
    <p style="line-height:1.6">${scope}</p>
    <p style="color:#6b7280;font-size:13px">Por seguridad, cambia la contraseña después del primer ingreso y no compartas estas credenciales.</p>
    <p style="margin-bottom:0">Área de Sistemas · The Victoria School</p>
  </div>
</div>`;
  return { text, html, subject: 'Acceso al panel FleetControl · The Victoria School' };
}

async function resendFromFile() {
  const file = process.env.CREDENTIALS_FILE || path.join(DATA_DIR, 'credenciales_usuarios.txt');
  if (!fs.existsSync(file)) throw new Error(`No existe ${file}. Ejecuta primero el aprovisionamiento sin --resend.`);
  let txt = fs.readFileSync(file, 'utf8');
  const results = [];
  for (const block of txt.split(/\n{2,}/)) {
    const get = (label) => (block.match(new RegExp('^' + label + ':\\s*(.*)$', 'm')) || [])[1] || '';
    const username = get('Usuario').trim();
    const password = get('Contraseña').trim();
    const role = (get('Rol').match(/\(([^)]+)\)\s*$/) || [])[1];
    const name = get('Nombre').trim();
    if (!username || !password || !isRole(role)) continue;
    try {
      const r = await mailer.sendMail({ to: username, ...emailBody({ username, name, role }, password) });
      results.push({ username, ok: true, transport: r.transport });
    } catch (e) {
      results.push({ username, ok: false, error: e.message });
    }
  }
  for (const r of results) {
    const esc = r.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(Usuario:\\s+' + esc + '[\\s\\S]*?Correo enviado:\\s+)[^\\n]*');
    txt = txt.replace(re, `$1${r.ok ? `sí (${r.transport})` : `no — ${r.error}`}`);
  }
  fs.writeFileSync(file, txt, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* noop */ }
  console.log(`\nReenvío desde ${file}`);
  for (const r of results) console.log(`${r.username} · correo: ${r.ok ? 'enviado (' + r.transport + ')' : 'NO enviado — ' + r.error}`);
}

async function main() {
  if (process.argv.includes('--resend')) return resendFromFile();
  const results = [];
  const stmtExisting = db.prepare('SELECT * FROM admins WHERE username = ?');
  const insert = db.prepare('INSERT INTO admins(username, password_hash, role, email) VALUES(?,?,?,?)');
  const update = db.prepare('UPDATE admins SET password_hash = ?, role = ?, email = ? WHERE id = ?');

  for (const u of USERS) {
    if (!isRole(u.role)) throw new Error(`Rol inválido para ${u.username}: ${u.role}`);
    const password = strongPassword(16);
    const hash = hashPassword(password);
    const existing = stmtExisting.get(u.username);
    if (existing) {
      update.run(hash, u.role, u.username, existing.id);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(existing.id);
    } else {
      insert.run(u.username, hash, u.role, u.username);
    }
    audit('sistema', existing ? 'usuario_actualizado' : 'usuario_creado', u.username, { role: u.role });

    let mail = { ok: false, error: null, transport: null };
    if (SEND_EMAIL) {
      try {
        const r = await mailer.sendMail({ to: u.username, ...emailBody(u, password) });
        mail = { ok: true, error: null, transport: r.transport };
      } catch (e) {
        mail = { ok: false, error: e.message, transport: null };
      }
    }
    results.push({ ...u, password, existing: Boolean(existing), mail });
  }

  const file = process.env.CREDENTIALS_FILE || path.join(DATA_DIR, 'credenciales_usuarios.txt');
  const lines = [
    'FleetControl · The Victoria School',
    'Usuarios y contraseñas del panel',
    '',
    `Panel:  ${PANEL_URL}`,
    `Fecha:  ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `Correo: ${SEND_EMAIL ? 'intentado (ver resultado por usuario)' : 'no solicitado (--no-email)'}`,
    '',
    'Roles:',
    '  aprendiz → solo registrar equipos y cerrar sesiones de Google Workspace de "Estudiantes Activos".',
    '  auxiliar → acceso completo.',
    '  jefe     → acceso completo.',
    '',
    '----------------------------------------------------------------------',
    '',
    ...results.map((r) => [
      `Usuario:          ${r.username}`,
      `Contraseña:       ${r.password}`,
      `Rol:              ${roleInfo(r.role).label} (${r.role})`,
      `Nombre:           ${r.name}`,
      `Correo enviado:   ${SEND_EMAIL ? (r.mail.ok ? `sí (${r.mail.transport})` : `no — ${r.mail.error}`) : 'no solicitado'}`,
      '',
    ].join('\n')),
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* noop */ }

  console.log(`\nCredenciales escritas en ${file}`);
  for (const r of results) {
    console.log(`${r.username} · ${r.role} · correo: ${r.mail.ok ? 'enviado (' + r.mail.transport + ')' : 'NO enviado' + (r.mail.error ? ' — ' + r.mail.error : '')}`);
  }
  if (SEND_EMAIL && results.some((r) => !r.mail.ok)) {
    console.log('\nAviso: configura SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS o el alcance gmail.send para enviar los correos.');
  }
}

main().catch((e) => { console.error('Error:', e.message); process.exitCode = 1; });
