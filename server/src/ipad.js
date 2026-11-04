'use strict';
// Registro de iPad mediante el "Profile Service" de Apple (inscripción por perfil OTA).
// 1) El iPad abre en Safari /enroll/ipad/<token> y descarga un perfil de tipo "Profile Service".
// 2) Al instalarlo, iPadOS envía (POST, plist firmado) su UDID, número de serie, modelo y versión.
// 3) El servidor registra el equipo y responde con un perfil final que queda instalado como marca.
// No requiere certificados de Apple; las acciones remotas sobre el iPad (borrar, instalar apps)
// necesitan un MDM de Apple con certificado APNs (ver README).
const crypto = require('node:crypto');

const MODELS = {
  'iPad6,11': 'iPad (5.ª generación)', 'iPad6,12': 'iPad (5.ª generación)',
  'iPad7,5': 'iPad (6.ª generación)', 'iPad7,6': 'iPad (6.ª generación)',
  'iPad7,11': 'iPad (7.ª generación)', 'iPad7,12': 'iPad (7.ª generación)',
  'iPad11,6': 'iPad (8.ª generación)', 'iPad11,7': 'iPad (8.ª generación)',
  'iPad12,1': 'iPad (9.ª generación)', 'iPad12,2': 'iPad (9.ª generación)',
  'iPad13,18': 'iPad (10.ª generación)', 'iPad13,19': 'iPad (10.ª generación)',
  'iPad15,7': 'iPad (A16)', 'iPad15,8': 'iPad (A16)',
};
const modelName = (product) => {
  if (!product) return 'iPad';
  const name = MODELS[product];
  const conn = ['iPad7,12', 'iPad6,12', 'iPad7,6', 'iPad11,7', 'iPad12,2', 'iPad13,19', 'iPad15,8'].includes(product) ? 'Wi-Fi + Cellular' : 'Wi-Fi';
  return name ? `${name} ${conn} (${product})` : product;
};

const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function uuidFrom(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

function plist(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${inner}
</plist>
`;
}

/** Perfil inicial que pide al iPad sus datos. */
function enrollmentProfile({ serverUrl, token, orgName }) {
  const id = 'co.edu.fleetcontrol.enroll';
  return plist(`<dict>
  <key>PayloadContent</key>
  <dict>
    <key>URL</key><string>${xmlEsc(serverUrl)}/enroll/ipad/profile-service</string>
    <key>DeviceAttributes</key>
    <array>
      <string>UDID</string><string>SERIAL</string><string>PRODUCT</string>
      <string>VERSION</string><string>DEVICE_NAME</string><string>IMEI</string>
    </array>
    <key>Challenge</key><string>${xmlEsc(token)}</string>
  </dict>
  <key>PayloadOrganization</key><string>${xmlEsc(orgName)}</string>
  <key>PayloadDisplayName</key><string>Registro de iPad · ${xmlEsc(orgName)}</string>
  <key>PayloadDescription</key><string>Registra este iPad en el inventario de TI de ${xmlEsc(orgName)}.</string>
  <key>PayloadIdentifier</key><string>${id}</string>
  <key>PayloadUUID</key><string>${uuidFrom(id + token)}</string>
  <key>PayloadType</key><string>Profile Service</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>`);
}

/** Perfil final que queda instalado: un acceso directo al sitio de soporte del colegio. */
function finalProfile({ orgName, deviceId, supportUrl }) {
  const id = 'co.edu.fleetcontrol.registered';
  return plist(`<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.webClip.managed</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>${id}.webclip</string>
      <key>PayloadUUID</key><string>${uuidFrom(id + 'webclip' + deviceId)}</string>
      <key>PayloadDisplayName</key><string>Acceso directo</string>
      <key>Label</key><string>${xmlEsc(orgName)}</string>
      <key>URL</key><string>${xmlEsc(supportUrl)}</string>
      <key>IsRemovable</key><true/>
      <key>FullScreen</key><false/>
    </dict>
  </array>
  <key>PayloadOrganization</key><string>${xmlEsc(orgName)}</string>
  <key>PayloadDisplayName</key><string>${xmlEsc(orgName)} · Equipo registrado</string>
  <key>PayloadDescription</key><string>Este iPad está registrado en el inventario de TI (ID ${xmlEsc(deviceId)}).</string>
  <key>PayloadIdentifier</key><string>${id}</string>
  <key>PayloadUUID</key><string>${uuidFrom(id + deviceId)}</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>`);
}

/** Extrae el diccionario <key>/<string> del plist que viene dentro del PKCS#7 firmado. */
function parseDeviceAttributes(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < 0) return null;
  const xml = Buffer.from(text.slice(start, end + 8), 'latin1').toString('utf8');
  const out = {};
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let m;
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  while ((m = re.exec(xml))) out[m[1]] = unesc(m[2]);
  return out;
}

module.exports = { enrollmentProfile, finalProfile, parseDeviceAttributes, modelName };
