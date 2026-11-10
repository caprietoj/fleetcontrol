'use strict';
// Envío de correo para avisos del panel (credenciales de acceso, etc.).
// Prioridad: SMTP configurado por variables de entorno → Gmail API con la
// cuenta de servicio (delegación de dominio) si está disponible.
const fs = require('node:fs');
const crypto = require('node:crypto');

const FROM = process.env.SMTP_FROM || 'FleetControl <no-responder@tvs.edu.co>';

function smtpConfig() {
  if (!process.env.SMTP_HOST) return null;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' : port === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  };
}

function gmailKey() {
  const file = process.env.GOOGLE_SA_KEY_FILE;
  const inline = process.env.GOOGLE_SA_KEY_JSON;
  if (!file && !inline) return null;
  if (!process.env.GOOGLE_ADMIN_EMAIL) return null;
  try { return JSON.parse(inline || fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function status() {
  const smtp = smtpConfig();
  const key = gmailKey();
  return {
    configured: Boolean(smtp || key),
    transport: smtp ? 'smtp' : key ? 'gmail' : null,
    from: FROM,
    smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure, user: process.env.SMTP_USER || null } : null,
    gmail: key ? { serviceAccount: key.client_email, adminEmail: process.env.GOOGLE_ADMIN_EMAIL } : null,
  };
}

async function sendViaSmtp(cfg, { to, subject, text, html }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport(cfg);
  return transporter.sendMail({ from: FROM, to, subject, text, html });
}

let gmailTokenCache = null;
async function gmailAccessToken(key) {
  if (gmailTokenCache && gmailTokenCache.exp > Date.now() + 60_000) return gmailTokenCache.token;
  const admin = process.env.GOOGLE_ADMIN_EMAIL;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    sub: admin,
    scope: 'https://www.googleapis.com/auth/gmail.send',
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
  if (!res.ok) throw new Error(`Google no autorizó el envío de correo: ${data.error_description || data.error || res.status}. Activa el alcance gmail.send en la delegación de dominio.`);
  gmailTokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return gmailTokenCache.token;
}

const mime = (s) => `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;
const address = (s) => String(s).replace(/[\r\n]/g, ' ').trim();

async function sendViaGmail(key, { to, subject, text, html }) {
  const token = await gmailAccessToken(key);
  const boundary = 'fc-' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${address(FROM)}`,
    `To: ${address(to)}`,
    `Subject: ${mime(subject)}`,
    'MIME-Version: 1.0',
  ];
  let body;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text || '', 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html, 'utf8').toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    body = Buffer.from(text || '', 'utf8').toString('base64');
  }
  const raw = Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body, 'utf8').toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || `Gmail devolvió HTTP ${res.status}`);
  return data;
}

async function sendMail({ to, subject, text, html }) {
  const smtp = smtpConfig();
  if (smtp) return { transport: 'smtp', result: await sendViaSmtp(smtp, { to, subject, text, html }) };
  const key = gmailKey();
  if (key) return { transport: 'gmail', result: await sendViaGmail(key, { to, subject, text, html }) };
  throw new Error('No hay servidor de correo configurado. Define SMTP_HOST, SMTP_PORT, SMTP_USER y SMTP_PASS (o habilita gmail.send para la cuenta de servicio).');
}

module.exports = { status, sendMail, FROM };
