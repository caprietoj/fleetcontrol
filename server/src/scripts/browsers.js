'use strict';
// Rutas de datos de navegadores, relativas a la carpeta de cada usuario.
// "*" se expande como comodín en el equipo; el resto se usa literal.

const CHROMIUM_PROFILES = ['Default', 'Profile *', 'Guest Profile', 'System Profile'];

const CHROMIUM_ITEMS = {
  cookies: ['Cookies', 'Cookies-journal', 'Network/Cookies', 'Network/Cookies-journal', 'Extension Cookies', 'Extension Cookies-journal', 'Safe Browsing Cookies'],
  sessions: ['Sessions', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', 'Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker', 'File System', 'WebStorage', 'databases', 'Shared Dictionary'],
  history: ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal', 'Shortcuts', 'Shortcuts-journal', 'Favicons', 'Favicons-journal'],
  cache: ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache'],
  passwords: ['Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal'],
  // Tokens de la cuenta de Google con la que se inició sesión en el navegador + autocompletar
  accounts: ['Web Data', 'Web Data-journal', 'Account Web Data', 'Account Web Data-journal'],
};

const CHROMIUM = {
  chrome: {
    label: 'Google Chrome',
    mac: { base: 'Library/Application Support/Google/Chrome', cache: 'Library/Caches/Google/Chrome', proc: 'Google Chrome' },
    win: { base: 'AppData/Local/Google/Chrome/User Data', proc: 'chrome' },
  },
  edge: {
    label: 'Microsoft Edge',
    mac: { base: 'Library/Application Support/Microsoft Edge', cache: 'Library/Caches/Microsoft Edge', proc: 'Microsoft Edge' },
    win: { base: 'AppData/Local/Microsoft/Edge/User Data', proc: 'msedge' },
  },
  brave: {
    label: 'Brave',
    mac: { base: 'Library/Application Support/BraveSoftware/Brave-Browser', cache: 'Library/Caches/BraveSoftware/Brave-Browser', proc: 'Brave Browser' },
    win: { base: 'AppData/Local/BraveSoftware/Brave-Browser/User Data', proc: 'brave' },
  },
};

const FIREFOX_ITEMS = {
  cookies: ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm'],
  sessions: ['sessionstore.jsonlz4', 'sessionstore-backups', 'storage', 'webappsstore.sqlite', 'webappsstore.sqlite-wal'],
  history: ['places.sqlite', 'places.sqlite-wal', 'places.sqlite-shm', 'favicons.sqlite', 'favicons.sqlite-wal', 'formhistory.sqlite'],
  cache: [], // ver cacheDirs
  passwords: ['logins.json', 'logins-backup.json', 'key4.db'],
  accounts: ['signedInUser.json'],
};
const FIREFOX = {
  label: 'Firefox',
  mac: { base: 'Library/Application Support/Firefox', profiles: 'Library/Application Support/Firefox/Profiles/*', cacheBase: 'Library/Caches/Firefox', cache: 'Library/Caches/Firefox/Profiles/*', proc: 'firefox' },
  win: { base: 'AppData/Roaming/Mozilla/Firefox', profiles: 'AppData/Roaming/Mozilla/Firefox/Profiles/*', cacheBase: 'AppData/Local/Mozilla/Firefox', cache: 'AppData/Local/Mozilla/Firefox/Profiles/*', proc: 'firefox' },
};

const SAFARI_ITEMS = {
  cookies: ['Library/Cookies/Cookies.binarycookies', 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies', 'Library/HTTPStorages/com.apple.Safari', 'Library/Containers/com.apple.Safari/Data/Library/HTTPStorages'],
  sessions: ['Library/Safari/LastSession.plist', 'Library/Safari/SafariTabs.db', 'Library/Safari/SafariTabs.db-wal', 'Library/Safari/SafariTabs.db-shm', 'Library/Safari/LocalStorage', 'Library/Safari/Databases', 'Library/WebKit/com.apple.Safari', 'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData'],
  history: ['Library/Safari/History.db', 'Library/Safari/History.db-lock', 'Library/Safari/History.db-shm', 'Library/Safari/History.db-wal', 'Library/Safari/RecentlyClosedTabs.plist'],
  cache: ['Library/Caches/com.apple.Safari', 'Library/Containers/com.apple.Safari/Data/Library/Caches'],
  passwords: [], // Safari guarda contraseñas en el Llavero (no se toca)
  accounts: [],
};

const ITEMS = ['cookies', 'sessions', 'history', 'cache', 'passwords', 'accounts', 'full_reset'];
const BROWSERS = ['chrome', 'edge', 'brave', 'firefox', 'safari'];

/**
 * Devuelve { procs: [...], paths: [...] } con rutas relativas al home del usuario.
 */
function browserTargets(platform, browsers, items) {
  const os = platform === 'macos' ? 'mac' : 'win';
  const procs = [];
  const paths = [];
  const full = items.includes('full_reset');

  for (const b of browsers) {
    if (CHROMIUM[b]) {
      const cfg = CHROMIUM[b][os];
      procs.push(cfg.proc);
      if (full) {
        paths.push(cfg.base);
        if (cfg.cache) paths.push(cfg.cache);
        continue;
      }
      for (const it of items) {
        for (const prof of CHROMIUM_PROFILES) {
          for (const f of CHROMIUM_ITEMS[it] || []) paths.push(`${cfg.base}/${prof}/${f}`);
        }
        if (it === 'cache' && cfg.cache) paths.push(cfg.cache);
      }
    } else if (b === 'firefox') {
      const cfg = FIREFOX[os];
      procs.push(cfg.proc);
      if (full) { paths.push(cfg.base, cfg.cacheBase); continue; }
      for (const it of items) {
        for (const f of FIREFOX_ITEMS[it] || []) paths.push(`${cfg.profiles}/${f}`);
        if (it === 'cache') paths.push(`${cfg.cache}/cache2`, `${cfg.cache}/startupCache`, `${cfg.cache}/thumbnails`);
      }
    } else if (b === 'safari' && os === 'mac') {
      procs.push('Safari');
      const its = full ? Object.keys(SAFARI_ITEMS) : items;
      for (const it of its) paths.push(...(SAFARI_ITEMS[it] || []));
    }
  }
  return { procs: [...new Set(procs)], paths: [...new Set(paths)] };
}

module.exports = { browserTargets, ITEMS, BROWSERS };
