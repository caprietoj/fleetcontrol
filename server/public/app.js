'use strict';
// ===================== utilidades =====================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Sesión expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 4000);
}

function ago(ts) {
  if (!ts) return 'nunca';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'hace segundos';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}
const fmtDate = (ts) => (ts ? new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('es-CO') : '');
const STATUS = { pending: 'Pendiente', running: 'Ejecutando', success: 'Correcto', failed: 'Falló', cancelled: 'Cancelado', skipped: 'Omitido' };
const stBadge = (s) => `<span class="st ${esc(s)}">${STATUS[s] || esc(s)}</span>`;
const platTag = (p) => (p === 'macos' ? '<span class="tag mac">macOS</span>' : '<span class="tag win">Windows</span>');

// ===================== estado =====================
const state = { devices: [], selected: new Set(), settings: null, packages: [], view: 'devices' };

// ===================== login =====================
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    $('#loginError').textContent = '';
    init();
  } catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => { await api('/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); });

// ===================== navegación =====================
function go(view) {
  state.view = view;
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $$('main .view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== view));
  ({ devices: loadDevices, software: loadPackages, history: loadHistory, google: loadGoogle, enroll: loadEnroll, settings: loadAdmins, audit: loadAudit }[view] || (() => {}))();
}
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav && nav.tagName === 'A') { go(nav.dataset.view); return; }
  const g = e.target.closest('[data-goto]');
  if (g) { $('#modal').classList.add('hidden'); $('#drawer').classList.add('hidden'); go(g.dataset.goto); return; }
  const c = e.target.closest('[data-close]');
  if (c) { $('#' + c.dataset.close).classList.add('hidden'); return; }
  const cp = e.target.closest('[data-copy]');
  if (cp) { navigator.clipboard.writeText($('#' + cp.dataset.copy).textContent).then(() => toast('Copiado')); }
});
['drawer', 'modal'].forEach((id) => $('#' + id).addEventListener('click', (e) => { if (e.target.id === id) e.target.classList.add('hidden'); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#modal').classList.add('hidden'); $('#drawer').classList.add('hidden'); } });

// ===================== dispositivos =====================
async function loadDevices() {
  const [devices, stats] = await Promise.all([api('/devices'), api('/stats')]);
  state.devices = devices;
  const ids = new Set(devices.map((d) => d.id));
  state.selected.forEach((id) => { if (!ids.has(id)) state.selected.delete(id); });
  $('#stats').innerHTML = [
    ['Equipos', stats.total || 0], ['En línea', stats.online || 0], ['MacBook', stats.macos || 0],
    ['Windows / Lenovo', stats.windows || 0], ['Acciones en cola', stats.pending || 0],
  ].map(([l, v]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  const groups = [...new Set(devices.map((d) => d.group_name).filter(Boolean))].sort();
  const fg = $('#fGroup'); const cur = fg.value;
  fg.innerHTML = '<option value="">Todos los grupos</option>' + groups.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  renderDevices();
}

function filteredDevices() {
  const q = $('#search').value.trim().toLowerCase();
  const p = $('#fPlatform').value, g = $('#fGroup').value, s = $('#fStatus').value;
  return state.devices.filter((d) => {
    if (p && d.platform !== p) return false;
    if (g && d.group_name !== g) return false;
    if (s === 'online' && !(d.online && d.status !== 'retired')) return false;
    if (s === 'offline' && (d.online || d.status === 'retired')) return false;
    if (s === 'retired' && d.status !== 'retired') return false;
    if (!s && d.status === 'retired' && !q) return false;
    if (q) {
      const hay = [d.hostname, d.serial, d.model, d.logged_user, d.google_email, ...(d.google_accounts || []), d.group_name, d.ip].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderDevices() {
  const list = filteredDevices();
  $('#devEmpty').classList.toggle('hidden', state.devices.length > 0);
  $('#devTable tbody').innerHTML = list.map((d) => {
    const pct = d.disk_total_gb ? Math.round((d.disk_free_gb / d.disk_total_gb) * 100) : null;
    const g = [d.google_email, ...(d.google_accounts || [])].filter((x, i, a) => x && a.indexOf(x) === i);
    return `<tr data-id="${esc(d.id)}">
      <td class="chk"><input type="checkbox" ${state.selected.has(d.id) ? 'checked' : ''}></td>
      <td><span class="dot ${d.online && d.status !== 'retired' ? 'on' : ''}"></span><b>${esc(d.hostname || '(sin nombre)')}</b>
        ${d.pending ? ` <span class="tag">${d.pending} en cola</span>` : ''}${d.status === 'retired' ? ' <span class="tag">retirado</span>' : ''}
        <div class="sub">${esc(d.model || '')} · S/N ${esc(d.serial || '—')}</div></td>
      <td>${esc(d.logged_user || '—')}<div class="sub">${g.map(esc).join(', ') || 'sin cuenta Google detectada'}</div></td>
      <td>${platTag(d.platform)}<div class="sub">${esc(d.os_version || '')}</div></td>
      <td>${pct === null ? '—' : `${d.disk_free_gb} GB libres<div class="bar"><i class="${pct < 10 ? 'low' : ''}" style="width:${100 - pct}%"></i></div>`}</td>
      <td>${d.group_name ? `<span class="tag">${esc(d.group_name)}</span>` : '<span class="sub">—</span>'}</td>
      <td>${ago(d.last_seen)}<div class="sub">${esc(d.ip || '')}</div></td>
    </tr>`;
  }).join('');
  updateSelection();
}

function updateSelection() {
  const n = state.selected.size;
  $('#selCount').textContent = n ? `${n} seleccionado${n > 1 ? 's' : ''}` : 'Selecciona equipos para aplicar acciones';
  $('#bulkBar').classList.toggle('disabled', n === 0);
  const visible = filteredDevices();
  $('#selAll').checked = visible.length > 0 && visible.every((d) => state.selected.has(d.id));
}

['#search', '#fPlatform', '#fGroup', '#fStatus'].forEach((s) => $(s).addEventListener('input', renderDevices));
$('#selAll').addEventListener('change', (e) => {
  filteredDevices().forEach((d) => (e.target.checked ? state.selected.add(d.id) : state.selected.delete(d.id)));
  renderDevices();
});
$('#devTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.closest('td.chk')) {
    const cb = $('input', tr);
    if (e.target !== cb) cb.checked = !cb.checked;
    cb.checked ? state.selected.add(id) : state.selected.delete(id);
    updateSelection();
    return;
  }
  openDevice(id);
});

$('#moreBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#moreMenu').classList.toggle('hidden'); });
document.addEventListener('click', () => $('#moreMenu').classList.add('hidden'));
$('#bulkBar').addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]'); if (!a) return;
  if (!state.selected.size) return toast('Selecciona al menos un equipo', true);
  openAction(a.dataset.action, [...state.selected]);
});

// ===================== ficha del dispositivo =====================
async function openDevice(id) {
  const { device: d, commands, software } = await api('/devices/' + encodeURIComponent(id));
  const body = $('#drawerBody');
  body.innerHTML = `
    <h1><span class="dot ${d.online ? 'on' : ''}"></span>${esc(d.hostname)}</h1>
    <p class="muted">${platTag(d.platform)} ${esc(d.model || '')} · ${d.online ? 'En línea' : 'Desconectado'} · visto ${ago(d.last_seen)}</p>
    <div class="quick">
      ${['google_signout', 'clean_browsers', 'delete_files', 'install_software', 'list_software', 'message', 'restart']
        .map((t) => `<button class="btn small" data-act="${t}">${esc(state.settings.types[t])}</button>`).join('')}
    </div>
    <div class="section-title">Información</div>
    <dl class="kv">
      <dt>Número de serie</dt><dd>${esc(d.serial || '—')}</dd>
      <dt>Fabricante</dt><dd>${esc(d.manufacturer || '—')}</dd>
      <dt>Sistema</dt><dd>${esc(d.os_version || '—')}</dd>
      <dt>Procesador</dt><dd>${esc(d.cpu || '—')}</dd>
      <dt>Memoria</dt><dd>${d.ram_gb ? esc(d.ram_gb) + ' GB' : '—'}</dd>
      <dt>Disco</dt><dd>${d.disk_total_gb ? `${esc(d.disk_free_gb)} GB libres de ${esc(d.disk_total_gb)} GB` : '—'}</dd>
      <dt>IP</dt><dd>${esc(d.ip || '—')}</dd>
      <dt>Usuario actual</dt><dd>${esc(d.logged_user || '—')}</dd>
      <dt>Cuentas Google detectadas</dt><dd>${(d.google_accounts || []).map(esc).join('<br>') || '—'}</dd>
      <dt>Registrado</dt><dd>${fmtDate(d.enrolled_at)}</dd>
      <dt>Agente</dt><dd>${esc(d.agent_version || '—')}</dd>
    </dl>
    <div class="section-title">Administración</div>
    <form id="devForm" class="card">
      <label>Correo Google Workspace asignado<input name="google_email" value="${esc(d.google_email || '')}" placeholder="usuario@tuempresa.com"></label>
      <label>Grupo<input name="group_name" value="${esc(d.group_name || '')}" placeholder="Ventas, Diseño…" list="groupList"></label>
      <datalist id="groupList">${[...new Set(state.devices.map((x) => x.group_name).filter(Boolean))].map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
      <label>Notas<textarea name="notes" rows="2">${esc(d.notes || '')}</textarea></label>
      <div class="modal-actions">
        <button type="button" class="btn danger-outline" id="delDev">Quitar del panel</button>
        <button class="btn primary" type="submit">Guardar</button>
      </div>
    </form>
    ${software ? `<div class="section-title">Software instalado (${fmtDate(software.finished_at)})</div><pre class="output">${esc(software.output)}</pre>` : ''}
    <div class="section-title">Historial</div>
    <table class="table compact clickable" id="devHist"><tbody>
      ${commands.map((c) => `<tr data-cid="${c.id}"><td>${esc(state.settings.types[c.type] || c.type)}<div class="sub">${esc(c.summary || '')}</div></td>
        <td>${stBadge(c.status)}</td><td class="sub">${ago(c.created_at)}</td></tr>`).join('') || '<tr><td class="muted">Sin acciones todavía</td></tr>'}
    </tbody></table>`;
  $('#drawer').classList.remove('hidden');

  $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => openAction(b.dataset.act, [d.id])));
  $('#devForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/devices/' + d.id, { method: 'PATCH', body: Object.fromEntries(f) });
      toast('Guardado'); loadDevices();
    } catch (err) { toast(err.message, true); }
  });
  $('#delDev').addEventListener('click', async () => {
    if (!confirm(`¿Quitar ${d.hostname} del panel? El agente dejará de recibir órdenes (no se desinstala del equipo; para eso usa "Desinstalar agente").`)) return;
    await api('/devices/' + d.id, { method: 'DELETE', body: {} });
    $('#drawer').classList.add('hidden'); state.selected.delete(d.id); loadDevices(); toast('Equipo quitado');
  });
  $('#devHist').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-cid]'); if (tr) openCommand(tr.dataset.cid); });
}

// ===================== acciones =====================
const BROWSERS = [['chrome', 'Chrome'], ['edge', 'Edge'], ['brave', 'Brave'], ['firefox', 'Firefox'], ['safari', 'Safari (Mac)']];
const ITEMS = [['cookies', 'Cookies'], ['sessions', 'Sesiones y almacenamiento de sitios'], ['accounts', 'Cuenta del navegador / autocompletar'],
  ['passwords', 'Contraseñas guardadas'], ['history', 'Historial'], ['cache', 'Caché'], ['full_reset', 'Restablecer perfil completo']];
const checks = (name, opts, on = []) => `<div class="checks">${opts.map(([v, l]) =>
  `<label class="check"><input type="checkbox" name="${name}" value="${v}" ${on.includes(v) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;

function selectedSummary(ids) {
  const devs = state.devices.filter((d) => ids.includes(d.id));
  const mac = devs.filter((d) => d.platform === 'macos').length;
  const win = devs.length - mac;
  const off = devs.filter((d) => !d.online).length;
  return `<p class="muted">${devs.length} equipo(s): ${mac} macOS, ${win} Windows.${off ? ` ${off} desconectado(s): la acción quedará en cola y se ejecutará cuando se conecten.` : ''}</p>`;
}

async function openAction(type, ids) {
  $('#moreMenu').classList.add('hidden');
  if (type === 'install_software') state.packages = await api('/packages');
  const T = state.settings.types;
  let form = '', confirmWord = null, danger = false;

  switch (type) {
    case 'google_signout':
      form = `<div class="${state.settings.google.configured ? 'warnbox' : 'dangerbox'}">${state.settings.google.configured
        ? 'Se cerrarán <b>todas</b> las sesiones de Google (Gmail, Drive, etc.) de las cuentas asignadas o detectadas en cada equipo, en cualquier dispositivo.'
        : 'Google Workspace no está configurado en el servidor: solo se podrá hacer la limpieza local de cookies. Ver “Google Workspace”.'}</div>
        <label>Correos adicionales (opcional, separados por coma)<input name="extra" placeholder="ana@tuempresa.com"></label>
        <label class="check"><input type="checkbox" name="clear_cookies" checked> También borrar cookies y sesiones de todos los navegadores del equipo</label>
        <label class="check"><input type="checkbox" name="revoke_tokens"> Revocar accesos de aplicaciones de terceros (OAuth)</label>`;
      break;
    case 'clean_browsers':
      form = `<h3>Navegadores</h3>${checks('browsers', BROWSERS, ['chrome', 'edge', 'safari', 'firefox', 'brave'])}
        <h3>Qué borrar</h3>${checks('items', ITEMS, ['cookies', 'sessions'])}
        <label>Solo para el usuario (opcional)<input name="user" placeholder="todos los usuarios del equipo"></label>
        <label class="check"><input type="checkbox" name="close" checked> Cerrar los navegadores antes de limpiar</label>
        <p class="hint">“Restablecer perfil completo” borra todo el perfil del navegador (marcadores y extensiones incluidos) y garantiza el cierre de cualquier sesión.</p>`;
      danger = true;
      break;
    case 'delete_files':
      form = `<div class="dangerbox">Los archivos se eliminan de forma permanente (no van a la papelera).</div>
        <h3>Carpetas de cada usuario</h3>${checks('presets', Object.entries(state.settings.file_presets))}
        <label>Rutas adicionales (una por línea). Usa <code>~/</code> para la carpeta del usuario y <code>*</code> como comodín.
          <textarea name="paths" rows="3" placeholder="~/Library/Application Support/Slack/*\n~/AppData/Roaming/Zoom/*\nC:/Users/Public/Documents/Empresa/*"></textarea></label>
        <label>Solo para el usuario (opcional)<input name="user" placeholder="todos los usuarios del equipo"></label>`;
      confirmWord = 'ELIMINAR'; danger = true;
      break;
    case 'install_software': {
      const opt = (pl) => '<option value="">— ninguno —</option>' + state.packages.filter((p) => p.platform === pl)
        .map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.kind)})</option>`).join('');
      form = state.packages.length ? `<label>Paquete para MacBook<select name="mac">${opt('macos')}</select></label>
        <label>Paquete para Windows / Lenovo<select name="win">${opt('windows')}</select></label>
        <p class="hint">Cada equipo instala el paquete de su plataforma. Agrega instaladores en “Catálogo de software”.</p>`
        : '<p>El catálogo está vacío. <a data-goto="software" data-close="modal">Agrega un paquete</a> primero.</p>';
      break;
    }
    case 'uninstall_software':
      form = `<label>Mac: nombre de la app en /Applications<input name="mac_app" placeholder="zoom.us"></label>
        <label>Windows: nombre del programa o ID de winget<input name="win_name" placeholder="Zoom  ó  Zoom.Zoom"></label>`;
      danger = true;
      break;
    case 'run_script':
      form = `<div class="warnbox">Se ejecuta como administrador (root / SYSTEM). Revisa el código antes de enviarlo.</div>
        <label>Script para macOS (bash)<textarea name="mac_script" rows="6" spellcheck="false"></textarea></label>
        <label>Script para Windows (PowerShell)<textarea name="win_script" rows="6" spellcheck="false"></textarea></label>`;
      danger = true;
      break;
    case 'message':
      form = `<label>Título<input name="title" value="Aviso de TI"></label>
        <label>Mensaje<textarea name="text" rows="3" placeholder="En 5 minutos se cerrarán los navegadores por mantenimiento."></textarea></label>`;
      break;
    case 'restart': case 'shutdown':
      form = `<label>Minutos de aviso<input name="delay" type="number" min="1" max="120" value="5"></label>`;
      break;
    case 'set_group':
      form = `<label>Grupo<input name="group" placeholder="Ventas" list="gl"></label><datalist id="gl">${[...new Set(state.devices.map((x) => x.group_name).filter(Boolean))]
        .map((g) => `<option value="${esc(g)}">`).join('')}</datalist><p class="hint">Déjalo vacío para quitar el grupo.</p>`;
      break;
    case 'remove_agent':
      form = '<div class="dangerbox">Se desinstalará el agente y el equipo dejará de poder administrarse hasta que se vuelva a registrar.</div>';
      confirmWord = 'DESINSTALAR'; danger = true;
      break;
    case 'list_software':
      form = '<p class="muted">Obtiene la lista de aplicaciones instaladas. La verás en la ficha de cada equipo.</p>';
      break;
    case 'update_agent':
      form = '<p class="muted">Descarga la última versión del agente desde este servidor.</p>';
      break;
  }

  $('#modalBody').innerHTML = `<h1>${esc(type === 'set_group' ? 'Asignar grupo' : T[type])}</h1>${selectedSummary(ids)}
    <form id="actionForm" class="card" style="border:0;padding:0">${form}
      ${confirmWord ? `<label>Escribe <b>${confirmWord}</b> para confirmar<input name="confirm" autocomplete="off"></label>` : ''}
      <div class="modal-actions"><button type="button" class="btn" data-close="modal">Cancelar</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" type="submit">Ejecutar en ${ids.length} equipo(s)</button></div>
    </form>`;
  $('#modal').classList.remove('hidden');

  $('#actionForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const all = (n) => f.getAll(n);
    if (confirmWord && f.get('confirm') !== confirmWord) return toast(`Escribe ${confirmWord} para confirmar`, true);
    const btn = $('button[type=submit]', e.target); btn.disabled = true;
    try {
      if (type === 'set_group') {
        await api('/devices/bulk-group', { method: 'POST', body: { device_ids: ids, group_name: f.get('group') } });
        toast('Grupo asignado');
      } else {
        const payload = {
          google_signout: () => ({ extra_emails: String(f.get('extra') || '').split(/[\s,;]+/).filter(Boolean), clear_cookies: f.has('clear_cookies'), revoke_tokens: f.has('revoke_tokens') }),
          clean_browsers: () => ({ browsers: all('browsers'), items: all('items'), user: f.get('user'), close_browsers: f.has('close') }),
          delete_files: () => ({ presets: all('presets'), paths: String(f.get('paths') || '').split('\n').map((s) => s.trim()).filter(Boolean), user: f.get('user') }),
          install_software: () => ({ mac_package_id: f.get('mac') || null, win_package_id: f.get('win') || null }),
          uninstall_software: () => ({ mac_app: f.get('mac_app'), win_name: f.get('win_name') }),
          run_script: () => ({ mac_script: f.get('mac_script'), win_script: f.get('win_script') }),
          message: () => ({ title: f.get('title'), text: f.get('text') }),
          restart: () => ({ delay_min: f.get('delay') }),
          shutdown: () => ({ delay_min: f.get('delay') }),
        }[type];
        const r = await api('/commands', { method: 'POST', body: { type, device_ids: ids, payload: payload ? payload() : {} } });
        const parts = [];
        if (r.done) parts.push(`${r.done} completadas`);
        if (r.failed) parts.push(`${r.failed} fallidas`);
        if (r.queued) parts.push(`${r.queued} en cola`);
        if (r.skipped) parts.push(`${r.skipped} omitidas`);
        toast('Acción enviada: ' + parts.join(', '), r.failed > 0);
      }
      $('#modal').classList.add('hidden');
      loadDevices();
      if (!$('#drawer').classList.contains('hidden') && ids.length === 1) openDevice(ids[0]);
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  });
}

// ===================== historial =====================
async function loadHistory() {
  const st = $('#hStatus').value;
  const rows = await api('/commands' + (st ? '?status=' + st : ''));
  $('#histTable tbody').innerHTML = rows.map((c) => `<tr data-cid="${c.id}"><td>${c.id}</td>
    <td>${esc(c.hostname || '(eliminado)')}</td><td>${esc(state.settings.types[c.type] || c.type)}</td>
    <td class="sub">${esc(c.summary || '')}</td><td>${stBadge(c.status)}</td><td>${esc(c.created_by || '')}</td>
    <td class="sub">${fmtDate(c.created_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin acciones</td></tr>';
}
$('#hStatus').addEventListener('change', loadHistory);
$('#histTable tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-cid]'); if (tr) openCommand(tr.dataset.cid); });

async function openCommand(id) {
  const c = await api('/commands/' + id);
  $('#modalBody').innerHTML = `<h1>${esc(state.settings.types[c.type] || c.type)} · ${esc(c.hostname || '')}</h1>
    <p>${stBadge(c.status)} <span class="muted">${esc(c.summary || '')}</span></p>
    <dl class="kv"><dt>Creado</dt><dd>${fmtDate(c.created_at)} por ${esc(c.created_by || '')}</dd>
      <dt>Enviado</dt><dd>${fmtDate(c.sent_at) || '—'}</dd><dt>Terminado</dt><dd>${fmtDate(c.finished_at) || '—'}</dd>
      <dt>Código de salida</dt><dd>${c.exit_code ?? '—'}</dd></dl>
    <h3>Resultado</h3><pre class="output">${esc(c.output || (c.status === 'pending' ? 'Esperando a que el equipo se conecte…' : '(sin salida)'))}</pre>
    ${c.script ? `<details><summary>Ver script ejecutado</summary><pre class="output">${esc(c.script)}</pre></details>` : ''}
    <div class="modal-actions">${c.status === 'pending' ? '<button class="btn danger-outline" id="cancelCmd">Cancelar</button>' : ''}
      <button class="btn" data-close="modal">Cerrar</button></div>`;
  $('#modal').classList.remove('hidden');
  const cb = $('#cancelCmd');
  if (cb) cb.addEventListener('click', async () => {
    try { await api(`/commands/${id}/cancel`, { method: 'POST', body: {} }); toast('Cancelado'); $('#modal').classList.add('hidden'); if (state.view === 'history') loadHistory(); }
    catch (err) { toast(err.message, true); }
  });
}

// ===================== software =====================
const KIND_HELP = {
  pkg: ['https://…/instalador.pkg', 'Paquete .pkg: se instala con installer.'],
  dmg: ['https://…/app.dmg', 'Imagen .dmg: copia la .app a /Applications o instala el .pkg que contenga.'],
  zip: ['https://…/app.zip', 'ZIP con una .app dentro: se copia a /Applications.'],
  msi: ['https://…/instalador.msi', 'MSI: se instala en silencio con msiexec /qn.'],
  exe: ['https://…/setup.exe', 'EXE: indica los argumentos silenciosos del instalador (p. ej. /S, /quiet, /silent).'],
  winget: ['Google.Chrome', 'winget: escribe el ID del paquete (búscalo con “winget search”). Es la opción más sencilla en Windows.'],
};
function updateKinds() {
  const pl = $('#pkgPlatform').value;
  const kinds = pl === 'macos' ? ['pkg', 'dmg', 'zip'] : ['winget', 'msi', 'exe'];
  $('#pkgKind').innerHTML = kinds.map((k) => `<option value="${k}">${k.toUpperCase()}</option>`).join('');
  updateKindHelp();
}
function updateKindHelp() {
  const [ph, help] = KIND_HELP[$('#pkgKind').value];
  $('#pkgSource').placeholder = ph; $('#pkgHint').textContent = help;
}
$('#pkgPlatform').addEventListener('change', updateKinds);
$('#pkgKind').addEventListener('change', updateKindHelp);
$('#pkgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/packages', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset(); updateKinds(); toast('Paquete agregado'); loadPackages();
  } catch (err) { toast(err.message, true); }
});
async function loadPackages() {
  state.packages = await api('/packages');
  $('#pkgTable tbody').innerHTML = state.packages.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${platTag(p.platform)}</td>
    <td>${esc(p.kind.toUpperCase())}</td><td class="sub" style="word-break:break-all">${esc(p.source)}${p.args ? ` <code>${esc(p.args)}</code>` : ''}</td>
    <td><button class="btn small danger-outline" data-del="${p.id}">Eliminar</button></td></tr>`).join('')
    || '<tr><td colspan="5" class="empty">Catálogo vacío</td></tr>';
}
$('#pkgTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]'); if (!b) return;
  if (!confirm('¿Eliminar este paquete del catálogo?')) return;
  await api('/packages/' + b.dataset.del, { method: 'DELETE', body: {} }); loadPackages();
});

// ===================== Google =====================
function loadGoogle() {
  const g = state.settings.google;
  $('#googleStatus').innerHTML = g.configured
    ? `<h3>✅ Conectado</h3><dl class="kv"><dt>Cuenta de servicio</dt><dd>${esc(g.serviceAccount)}</dd><dt>Administrador</dt><dd>${esc(g.adminEmail)}</dd>
       <dt>Dominios</dt><dd>${g.domains.length ? g.domains.map(esc).join(', ') : 'todos'}</dd></dl>`
    : `<h3>⚠️ No configurado</h3><p class="muted">${esc(g.error || '')} Para cerrar sesiones de Google de forma remota, configura una cuenta de servicio con delegación de dominio (pasos en el README) y define GOOGLE_SA_KEY_FILE y GOOGLE_ADMIN_EMAIL en el servidor.</p>`;
}
$('#googleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const emails = String(f.get('emails')).split(/[\s,;]+/).filter(Boolean);
  if (!confirm(`¿Cerrar todas las sesiones de ${emails.length} cuenta(s)?`)) return;
  try {
    const r = await api('/google/signout', { method: 'POST', body: { emails, revoke_tokens: f.has('revoke') } });
    $('#googleOut').textContent = r.output; $('#googleOut').classList.remove('hidden');
  } catch (err) { toast(err.message, true); }
});

// ===================== enrolamiento =====================
function loadEnroll() {
  const s = state.settings;
  $('#cmdMac').textContent = s.install_macos;
  $('#cmdWin').textContent = s.install_windows;
  $('#enrollToken').textContent = s.enrollment_token;
}
$('#rotateBtn').addEventListener('click', async () => {
  if (!confirm('¿Generar un nuevo token? Los comandos de instalación anteriores dejarán de funcionar.')) return;
  await api('/settings/rotate-token', { method: 'POST', body: {} });
  state.settings = await api('/settings'); loadEnroll(); toast('Token renovado');
});

// ===================== administradores =====================
async function loadAdmins() {
  const rows = await api('/admins');
  $('#adminTable tbody').innerHTML = rows.map((a) => `<tr><td><b>${esc(a.username)}</b><div class="sub">desde ${fmtDate(a.created_at)}</div></td>
    <td style="text-align:right"><button class="btn small danger-outline" data-deladmin="${a.id}">Eliminar</button></td></tr>`).join('');
}
$('#adminTable').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-deladmin]'); if (!b) return;
  if (!confirm('¿Eliminar este administrador?')) return;
  try { await api('/admins/' + b.dataset.deladmin, { method: 'DELETE', body: {} }); loadAdmins(); } catch (err) { toast(err.message, true); }
});
$('#adminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/admins', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); loadAdmins(); toast('Administrador creado'); }
  catch (err) { toast(err.message, true); }
});
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); toast('Contraseña actualizada'); }
  catch (err) { toast(err.message, true); }
});

// ===================== auditoría =====================
async function loadAudit() {
  const rows = await api('/audit');
  $('#auditTable tbody').innerHTML = rows.map((a) => `<tr><td class="sub">${fmtDate(a.created_at)}</td><td>${esc(a.actor || '')}</td>
    <td>${esc(a.action)}</td><td>${esc(a.target || '')}</td><td class="sub">${esc(a.ip || '')}</td></tr>`).join('');
}

// ===================== inicio =====================
async function init() {
  try {
    const me = await api('/me');
    state.settings = await api('/settings');
    $('#whoami').textContent = me.username;
    $('#insecureBanner').classList.toggle('hidden', !state.settings.insecure);
    showApp(); updateKinds(); go(state.view);
  } catch { showLogin(); }
}
setInterval(() => {
  if ($('#app').classList.contains('hidden') || document.hidden) return;
  if (state.view === 'devices') loadDevices().catch(() => {});
  if (state.view === 'history') loadHistory().catch(() => {});
}, 15000);
init();
