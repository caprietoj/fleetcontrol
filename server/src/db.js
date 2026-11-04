'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'fleetcontrol.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostname TEXT,
  serial TEXT,
  manufacturer TEXT,
  model TEXT,
  os_version TEXT,
  cpu TEXT,
  ram_gb REAL,
  disk_total_gb REAL,
  disk_free_gb REAL,
  ip TEXT,
  logged_user TEXT,
  google_accounts TEXT,
  google_email TEXT,
  agent_version TEXT,
  group_name TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT
);
CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  args TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  summary TEXT,
  payload TEXT,
  script TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  exit_code INTEGER,
  output TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id, status);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- migraciones ----------
for (const col of ['udid TEXT', 'imei TEXT', "enroll_method TEXT DEFAULT 'agent'"]) {
  try { db.exec(`ALTER TABLE devices ADD COLUMN ${col}`); } catch { /* ya existe */ }
}

// ---------- helpers ----------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function audit(actor, action, target, details, ip) {
  db.prepare('INSERT INTO audit(actor, action, target, details, ip) VALUES(?,?,?,?,?)')
    .run(actor || null, action, target || null, details ? JSON.stringify(details) : null, ip || null);
}

// ---------- bootstrap ----------
function bootstrap() {
  if (!getSetting('enrollment_token')) setSetting('enrollment_token', randomToken(24));

  const count = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  if (count === 0) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASSWORD || randomToken(12);
    db.prepare('INSERT INTO admins(username, password_hash) VALUES(?, ?)').run(user, hashPassword(pass));
    const msg = `Usuario administrador inicial: ${user}\nContraseña: ${pass}\n(Cámbiala en el panel (Administradores) y borra este archivo.)\n`;
    if (!process.env.ADMIN_PASSWORD) {
      fs.writeFileSync(path.join(DATA_DIR, 'initial-admin.txt'), msg, { mode: 0o600 });
    }
    console.log('\n==============================\n' + msg + '==============================\n');
  }
}

module.exports = {
  db, DATA_DIR, sha256, randomToken, hashPassword, verifyPassword,
  getSetting, setSetting, audit, bootstrap,
};
