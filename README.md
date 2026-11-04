# FleetControl: gestión de MacBook Air y Lenovo

FleetControl es una plataforma propia para registrar y administrar portátiles **macOS** y **Windows (Lenovo)** desde un panel web:

- **Registro de equipos** con un solo comando. El inventario se actualiza solo: modelo, número de serie, sistema, disco, RAM, IP, usuario conectado y cuentas de Google con sesión en el navegador.
- **Cierre de sesiones de Google Workspace** en todos los dispositivos del usuario (Gmail, Drive, etc.) a través de la API de administración de Google, más la limpieza local de cookies.
- **Limpieza de navegadores** (Chrome, Edge, Brave, Firefox y Safari): cookies, sesiones, cuentas, contraseñas, historial, caché o restablecimiento completo del perfil.
- **Eliminación de archivos**: Descargas, Escritorio, Documentos, Papelera, temporales o rutas propias con comodines.
- **Instalación masiva de software**: `.pkg`, `.dmg` y `.zip` en Mac; `winget`, `.msi` y `.exe` en Windows. También desinstalación e inventario de software.
- Scripts remotos, mensajes al usuario, reinicio y apagado.
- Varios administradores, historial con la salida de cada acción y un registro de auditoría.

## Cómo funciona

```
 Panel web (navegador)  ──HTTPS──►  Servidor FleetControl (Node.js + SQLite)  ◄──HTTPS──  Agentes
                                              │                                         ├─ macOS: LaunchDaemon (root) cada 60 s
                                              └──► Google Admin SDK (signOut)           └─ Windows: Tarea programada (SYSTEM) cada 1 min
```

Los agentes **no abren puertos**: cada minuto se conectan al servidor, envían su inventario y piden las acciones pendientes. Si un equipo está apagado, la acción queda en cola y se ejecuta cuando vuelva a conectarse. El servidor genera el script exacto de cada acción, y el panel muestra qué se ejecutó y qué devolvió.

---

## 1. Instalar el servidor

Requisitos: un servidor Linux con un dominio público (por ejemplo `mdm.tuempresa.com`) y **HTTPS**.

### Opción A: Docker (recomendada)

```bash
cp .env.example .env              # edita DOMAIN y, si quieres, las variables de Google
docker compose up -d
docker compose logs fleetcontrol  # aquí aparece la contraseña inicial del usuario admin
```

Caddy obtiene el certificado HTTPS automáticamente para tu dominio.

### Opción B: directo con Node.js 22.5 o superior

```bash
cd server
npm install
PUBLIC_URL=https://mdm.tuempresa.com PORT=8080 npm start
```

Publícalo detrás de un proxy con HTTPS (Caddy, Nginx o Cloudflare Tunnel). La contraseña inicial queda en `server/data/initial-admin.txt`. Cámbiala en **Administradores** y borra ese archivo.

> ⚠️ No uses la plataforma sin HTTPS: los tokens de los equipos viajarían sin cifrar.

---

## 2. Registrar los portátiles

En el panel, ve a **Registrar equipos** y copia el comando de cada plataforma.

**MacBook Air**: en Terminal:
```bash
curl -fsSL https://mdm.tuempresa.com/install/macos.sh | sudo bash -s -- TOKEN
```
Después concede **Acceso total al disco** a `/bin/bash` en *Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco* (botón `+`, luego `Cmd+Shift+G` y escribe `/bin/bash`). Sin este permiso, macOS no deja borrar las cookies de Safari ni el contenido de Descargas, Escritorio y Documentos. El panel avisa con `ERR … ¿falta Acceso total al disco?` cuando ocurre.
> Si tienes Apple Business Manager o un MDM, puedes conceder ese permiso de forma masiva con un perfil **PPPC** (Privacy Preferences Policy Control) para `/bin/bash`.

**Lenovo / Windows 10-11**: en PowerShell **como Administrador**:
```powershell
powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://mdm.tuempresa.com/install/windows.ps1))) -Token TOKEN"
```

Para registrar muchos equipos a la vez, distribuye ese comando con lo que ya uses (GPO o script de inicio en Windows; Apple Remote Desktop o un script en Mac). Cuando termines un lote, rota el token desde el panel.

Archivos del agente:
| | macOS | Windows |
|---|---|---|
| Carpeta | `/Library/Application Support/FleetControl/` | `C:\ProgramData\FleetControl\` |
| Servicio | `/Library/LaunchDaemons/com.fleetcontrol.agent.plist` | Tarea programada “FleetControl Agent” |
| Log | `agent.log` | `agent.log` |

---

## 3. Conectar Google Workspace (cierre remoto de sesiones)

Con esta conexión, “Cerrar sesiones de Google” ejecuta el cierre de sesión oficial de Google (`users.signOut`). Este cierra **todas** las sesiones web y de dispositivos del usuario, incluso en equipos que no tengan el agente.

1. En **Google Cloud Console**, crea un proyecto y habilita **Admin SDK API**.
2. Crea una **cuenta de servicio** y descarga su llave **JSON**.
3. En **admin.google.com → Seguridad → Acceso y control de datos → Controles de API → Delegación de todo el dominio**, agrega el *Client ID* de la cuenta de servicio con este alcance:
   ```
   https://www.googleapis.com/auth/admin.directory.user.security
   ```
4. En el servidor, define:
   ```
   GOOGLE_SA_KEY_FILE=/ruta/llave.json
   GOOGLE_ADMIN_EMAIL=admin@tuempresa.com     # un superadministrador de Workspace
   GOOGLE_DOMAINS=tuempresa.com               # solo se cierran cuentas de estos dominios
   ```
5. Reinicia el servidor. La sección **Google Workspace** del panel debe mostrar “Conectado”.

La plataforma toma los correos a cerrar del campo “Correo Google Workspace asignado” de cada equipo y de las cuentas que el agente detecta en Chrome, Edge y Brave. Las cuentas `@gmail.com` personales nunca se tocan en Google: `GOOGLE_DOMAINS` las filtra, y en esos casos solo aplica la limpieza local de cookies.

---

## 4. Instalar software de forma masiva

1. En **Catálogo de software**, agrega el instalador:
   - **Windows**: lo más fácil es **winget** con el ID del paquete (`Google.Chrome`, `Zoom.Zoom`, `Microsoft.Teams`, `SlackTechnologies.Slack`, `7zip.7zip`…). También acepta URL de `.msi` (instalación silenciosa automática) o `.exe` (con sus argumentos silenciosos, como `/S` o `/quiet`).
   - **Mac**: URL `https://` de un `.pkg`, de un `.dmg` (copia la `.app` o instala el `.pkg` que contenga) o de un `.zip` con una `.app`.
   - Opcional: el **SHA-256** del archivo, para verificar que no fue alterado.
2. En **Dispositivos**, filtra o selecciona los equipos (por ejemplo, un grupo completo), pulsa **Instalar software** y elige un paquete para Mac y otro para Windows. Cada equipo instala el de su plataforma.
3. Sigue el avance en **Historial de acciones**.

---

## 5. Seguridad

- Contraseñas de administradores con *scrypt*, sesiones de 12 horas en cookie `HttpOnly` y `SameSite=Strict`, y bloqueo tras 5 intentos fallidos.
- Cada equipo tiene su propio token (en el servidor solo se guarda su hash). Si quitas un equipo del panel, su token deja de funcionar.
- Las rutas a borrar se validan: no se aceptan rutas del sistema, `..`, caracteres de shell ni rutas demasiado amplias. Las acciones destructivas piden escribir una palabra de confirmación.
- Todo queda en **Auditoría**: quién hizo qué, cuándo y desde qué IP.
- El servidor puede ejecutar código como administrador en todos los equipos. Protege el acceso al panel, usa contraseñas largas y restringe el acceso por IP o VPN si puedes.

**Aspecto legal**: informa a los usuarios por escrito que los equipos son de la empresa y que TI puede administrarlos y borrar datos de forma remota. Si en los equipos hay datos personales, revisa tu política de tratamiento de datos (en Colombia, Ley 1581 de 2012).

---

## Variables de entorno

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP (por defecto 8080) |
| `PUBLIC_URL` | URL pública con https, usada en los comandos de instalación |
| `DATA_DIR` | Carpeta de la base de datos (por defecto `server/data`) |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Administrador inicial (solo en el primer arranque) |
| `TRUST_PROXY` | `0` si el servidor **no** está detrás de un proxy |
| `GOOGLE_SA_KEY_FILE` o `GOOGLE_SA_KEY_JSON` | Llave de la cuenta de servicio |
| `GOOGLE_ADMIN_EMAIL` | Superadministrador de Workspace al que suplanta la cuenta de servicio |
| `GOOGLE_DOMAINS` | Dominios administrados, separados por comas |

## Respaldo

Toda la información está en `server/data/fleetcontrol.db` (SQLite). Basta con copiar esa carpeta.

## Estructura

```
server/
  src/server.js            API del panel y de los agentes
  src/db.js                Base de datos SQLite
  src/google.js            Google Workspace (signOut, revocar tokens)
  src/scripts/commands.js  Validación y generación de scripts bash/PowerShell
  src/scripts/browsers.js  Rutas de datos de cada navegador
  public/                  Panel web
agents/
  macos/install.sh, agent.sh
  windows/install.ps1, agent.ps1
```
