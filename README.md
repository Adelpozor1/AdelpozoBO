# Panel Claude

Panel web para hablar con Claude (agéntico) y que actúe sobre una VPS.
Backend en **Python puro** (solo la stdlib) + el CLI `claude` ya instalado y
autenticado. Sin dependencias que instalar.

```
Navegador (frontend) ──► backend (127.0.0.1:8787) ──► claude -p (loop completo)
        chat / 2FA            API + streaming NDJSON         agente sobre la VPS
```

## Estructura

```
claude-panel/
├── backend/                 # servidor Python (API + puente a `claude`)
│   ├── server.py            # HTTP, login + 2FA, streaming del chat
│   ├── qr.py                # generador de QR en stdlib (para el alta del 2FA)
│   ├── claude-panel.service # unit de systemd
│   └── panel.conf.example   # plantilla de configuración (copiar a panel.conf)
└── frontend/                # interfaz web (estáticos)
    ├── index.html
    ├── styles.css
    └── app.js
```

El backend **sirve el frontend** (mismo origen → la cookie de sesión segura
funciona sin CORS). La carpeta a servir se configura con `staticdir` en
`panel.conf`; por defecto es `../frontend`.

## Puesta en marcha

```bash
git clone <este-repo> claude-panel
cd claude-panel/backend
cp panel.conf.example panel.conf      # password/secret/totp se autogeneran
python3 server.py                     # arranca en 127.0.0.1:8787
```

Al arrancar imprime la contraseña y la **inscripción del 2FA** (secreto + QR).

### Acceder (túnel SSH)

El backend solo escucha en `127.0.0.1` (no expone nada a internet). Desde tu
máquina local:

```bash
ssh -L 8787:127.0.0.1:8787 adelpozor@IP_DE_LA_VPS
```

Abre <http://localhost:8787> e introduce **contraseña + código 2FA**.

## 2FA (TOTP) — segundo factor obligatorio

El login pide contraseña **+** un código de 6 dígitos (Google Authenticator,
Authy, 1Password…). Todo con la stdlib: sin pip, sin SMTP, sin servicios
externos; el secreto vive solo en `panel.conf` (permisos 600) y nunca sale de
la VPS.

```bash
python3 backend/server.py --totp     # secreto + URI (+ QR si hay qrencode)
```

En la app de autenticación elige **"introducir clave manualmente"** y pega el
*Secreto* (base32). Si instalas `qrencode` (`sudo apt install qrencode`) el
comando muestra un QR más compacto; si no, se dibuja uno con `qr.py`.

Tras **5 intentos fallidos** el login se bloquea 5 minutos. Para desactivar el
2FA (no recomendado): `"totp_enabled": false` en `panel.conf`.

## Gestión del login (sin exponer secretos)

La contraseña se guarda **hasheada** (scrypt), nunca en texto plano. Para
crearla/cambiarla de forma interactiva (no se escribe en pantalla ni en logs):

```bash
python3 backend/server.py --set-password    # pide la contraseña por teclado (getpass)
python3 backend/server.py --reset-totp       # regenera el secreto 2FA y lo reimprime
```

Ambos **cierran todas las sesiones abiertas**. Tras usarlos:
`sudo systemctl restart claude-panel`.

**Sesiones:** cada login crea un token aleatorio con caducidad (`session_days`,
30 por defecto), guardado en `sessions.json` (revocable). El panel tiene botón
**Salir** (logout) que invalida la sesión en el servidor. La cookie es
`HttpOnly`, `SameSite=Strict` y `Secure` (`cookie_secure`).

## Zona de desarrollo (proyectos)

Cada proyecto es una subcarpeta de `projects_dir` (`~/projects` por defecto), un
`git clone`. Desde la web (barra lateral):

- **+ Clonar**: pega una URL git (SSH `git@…` para repos privados — la clave de
  la VPS está en tu cuenta de GitHub, así que clona tus privados).
- Selecciona un proyecto → el chat de Claude trabaja **dentro de esa carpeta**
  (`cwd` = proyecto), con sesión propia.
- Barra del proyecto: **Pull**, cambiar de **rama**, **Nueva** (reinicia la
  conversación) y **Borrar**.
- **Varios proyectos en paralelo**: cada uno tiene su lock; puedes lanzar Claude
  en uno y, mientras trabaja, cambiar a otro.

Claude corre con `--dangerously-skip-permissions` también aquí (autonomía total
dentro del proyecto). API: `GET /api/projects`, `POST /api/projects/{clone,pull,
checkout,delete}`, `GET /api/projects/branches`.

## Monitorización (segunda VPS por SSH)

La pestaña **Monitorización** da un informe casi instantáneo de otra VPS (la que
tiene n8n + PostgreSQL en Docker). El panel se conecta por **SSH con clave** y
ejecuta un recolector en una sola conexión; muestra cuatro tarjetas:

- **Sistema**: CPU, memoria, disco, carga, uptime y top de procesos.
- **Docker**: contenedores, estado y uso de CPU/memoria por contenedor.
- **n8n**: healthcheck, workflows activos y ejecuciones de las últimas 24 h
  (éxito/error) con las últimas ejecuciones (consultando la BD de n8n).
- **PostgreSQL**: estado (`pg_isready`), tamaño de la BD, conexiones y versión.

**Requisito**: el usuario del panel (el de systemd) debe poder entrar por SSH a
la otra VPS **sin contraseña** (clave autorizada). Si usas una clave concreta,
indícala en el campo *Ruta a la clave SSH*.

Desde la web: **+ Host** → nombre, usuario/IP/puerto SSH y nombres de los
contenedores de n8n y PostgreSQL (el botón **Probar conexión** lista los
contenedores en marcha para que copies sus nombres). Activa **Auto (10s)** para
refresco continuo. Los hosts se guardan en `backend/monitor.json` (permisos 600,
no se sube a git); la contraseña de la BD, si la pones, nunca se devuelve al
navegador.

API: `GET /api/monitor/hosts`, `GET /api/monitor/report?host=<id>`,
`POST /api/monitor/{hosts/save,hosts/delete,test}`.

## Persistencia (systemd)

```bash
sudo cp backend/claude-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-panel
journalctl -u claude-panel -f         # contraseña + inscripción 2FA al arrancar
```

## Configuración (`panel.conf`)

JSON autogenerado en el primer arranque (permisos 600, **no se sube a git**):

| Campo          | Qué es                                                    |
|----------------|-----------------------------------------------------------|
| `password_hash` | Hash scrypt de la contraseña (gestiónalo con `--set-password`) |
| `totp_secret`   | Secreto base32 del 2FA (no lo toques; ver `--totp`)          |
| `totp_enabled`  | `true` = exige código 2FA en el login                       |
| `host`          | Interfaz de escucha (por defecto `127.0.0.1`)               |
| `port`          | Puerto (`8787`)                                             |
| `staticdir`     | Carpeta del frontend a servir (por defecto `../frontend`)   |
| `workdir`       | Directorio donde trabaja el agente                          |
| `model`         | `null` (usa el del CLI), o `"opus"` / `"sonnet"` / …        |
| `claude_bin`    | Ruta al CLI `claude` (`null` = autodetectar)                |
| `cookie_secure` | Cookie solo por HTTPS (déjalo en `true`)                    |
| `session_days`  | Caducidad de la sesión en días (30)                        |
| `projects_dir`  | Carpeta de proyectos de desarrollo (`~/projects`)          |

## Seguridad (importante)

El agente corre con `--dangerously-skip-permissions`: ejecuta bash, edita
ficheros, etc. **sin pedir confirmación**. Quien pase el login controla la VPS.
Mantenlo tras túnel SSH o TLS + contraseña + 2FA, nunca en HTTP abierto a
internet.

Para acotar capacidades, edita el array `cmd` en `backend/server.py` (`_chat`):
cambia `--dangerously-skip-permissions` por `--permission-mode plan` (solo
planifica) o añade `--allowed-tools` / `--disallowed-tools`.

---

## Mapa: vista interactiva de la infraestructura (Fases 1–8)

El panel incluye una **vista Mapa** que renderiza en vivo la infraestructura
del usuario (VPSs + servicios alojados) a partir de un fichero por proyecto
(`.panel.json`) más probes en vivo por SSH. Todo sigue siendo stdlib en el
backend y vanilla HTML+SVG en el frontend (sin Three.js, sin build).

### Modelo de datos (schema v5)

Cada proyecto guarda en su carpeta:

| Fichero          | Contenido                                                |
|------------------|----------------------------------------------------------|
| `.panel.json`    | Servicios, conexiones, posiciones (permisos 600)         |
| `.linear.token`  | Token Linear del proyecto (permisos 600, opcional)       |
| `.alerts.json`   | Reglas de alerta (permisos 600, opcional)                |

`service.config` admite (Fase 6/8):

- `on_host`: id de la VPS que aloja el servicio (todo menos `vps`/satélite)
- `satellites_of`: id de la VPS sobre la que orbita un SaaS (`github`/`linear`)
- `role`: `db | backoffice | n8n | chatwoot | app | other` (opcional)
- `container`: nombre o prefijo del contenedor docker (opcional)
- `health_url`: URL para `curl http://...` desde la VPS (opcional, alertas)

Schema v4 sigue siendo aceptado por el backend (compat hacia atrás).

### Vista grid (Fase 7 + 8.5)

- Una tarjeta por **VPS declarada**, agrupadas por cliente.
- Cabecera con icono de estado vivo (🟢/⚠️/⛔), nombre y badge de alertas
  activas si hay.
- Mini-mapa SVG dentro de cada tarjeta: VPS centro + un punto por cada
  **categoría** de contenedor detectada (no por contenedor individual).
  Los datos se precargan en background tras el primer render.
- Badge dorado *testing* (producción del usuario) / gris *stg* en los nodos
  donde aplica.

Endpoint que la alimenta:

```
GET /api/world                                   → árbol cliente/proyecto/services
GET /api/projects/health?client&project          → estado VPS por id
GET /api/services/detail?client&project&service  → probe SSH al VPS (cacheado 15s)
GET /api/alerts/active                            → alertas firing globales
```

### Vista detalle (click en una tarjeta) (Fase 8.6)

- **Topología SVG grande**: VPS centro grande con `CPU/RAM/Disk` actuales + un
  nodo por **categoría** de contenedor (Backoffice, Frontoffice, Chatwoot,
  n8n, Base de datos, Cache/cola, Proxy/edge, Infraestructura, Otros) con su
  count visible.
- Carreteras radiales coloreadas según el estado del VPS (verde/ámbar/rojo).
- **Click en el VPS** → drawer con sistema completo + top procesos + lista de
  contenedores Docker.
- **Click en una categoría** → drawer lateral con sus contenedores
  sub-agrupados por env (testing / staging / global). Cada tile es clickable.
- **Click en un tile** (dentro del drawer de categoría):
  - Si el contenedor está vinculado a un *service declarado* (`config.container`
    coincide), abre el drawer del kind: workflows+ejecuciones n8n,
    monitor+schema postgres, logs chatwoot…
  - Si no, abre el drawer genérico con `docker inspect` + `docker logs --tail 200`.

Endpoint adicional (Fase 8.1):

```
GET /api/services/container?client&project&vps&container
```

### Clasificación automática de contenedores

El frontend clasifica cada container por su nombre vía regex (en `map2d.js`,
`classifyContainer`):

- `env`: detecta prefijos `testing_*` / `staging_*` / `stg_*` → testing / staging / global
- `role`: `backoffice`, `frontoffice`, `chatwoot`, `n8n`, `db` (postgres,
  base_de_datos, mysql, mongo), `cache` (redis, sidekiq, worker, rabbit),
  `proxy` (traefik, nginx, envoy, caddy), `infra` (easypanel, portainer, dokploy)
- Quita el sufijo de Docker Swarm (`.1.<task-id>`) para clasificar limpio.
- Etiqueta amigable quitando el prefijo de env.

### Alertas (Fase 8)

Reglas configurables por proyecto desde el tab **Alertas**:

| `kind`                  | Aplica a                  | Threshold | Dispara cuando                  |
|-------------------------|---------------------------|-----------|----------------------------------|
| `cpu_above`             | vps                       | 0–100 %   | `metrics.cpu_pct > N`           |
| `ram_above`             | vps                       | 0–100 %   | `metrics.ram_pct > N`           |
| `disk_above`            | vps                       | 0–100 %   | `metrics.disk_pct_max > N`      |
| `container_down`        | service con `container`   | —         | container no aparece running     |
| `n8n_workflow_failed`   | service `kind=n8n`        | —         | última ejecución `status=error` |
| `health_url_not_2xx`    | service con `health_url`  | —         | `curl` devuelve != 2xx           |

Evaluador integrado en el `health_poll_loop` (Fase 6) — cada 30 s reusa
`HEALTH_CACHE`/`DETAIL_CACHE` para no abrir SSH extra (excepto `health_url_not_2xx`
que sí hace un `curl` adicional por SSH).

Estado vivo: banner global rojo con count + lista, badge en cada card del grid.

Endpoints:

```
GET  /api/projects/alerts?client&project   → { rules, state }
POST /api/projects/alerts                  → body { client, project, rules }
GET  /api/alerts/active                    → todas las firing
```

### Cómo monitoriza el panel sin agente en la VPS

Toda la información proviene de **SSH `BatchMode=yes`** (clave autorizada) con
un único script bash que imprime secciones `@@nombre`. El parser desempaqueta
en JSON. Probes:

- `probe_vps` (reusa `build_collector` + `parse_report`): uptime, CPU, RAM,
  disco, top procs, docker overview, n8n via DB, postgres stats
- `probe_n8n`: `docker exec ... wget healthz` + tabla `workflow_entity`,
  `execution_entity`
- `probe_postgres`: `pg_isready`, size, conns, version, queries activas,
  `information_schema.tables/columns/table_constraints` (cap 200 tablas, 2000
  cols)
- `probe_container_logs`: `docker ps --filter name=^…` + `docker inspect` +
  `docker logs --tail 200 --timestamps` + opcional `curl <health_url>`

Cache en memoria (`DETAIL_CACHE`, TTL 15s) por `service_id` (o `<vps_id>::<container>`
para `/api/services/container`).

Requisito: el usuario SSH debe poder ejecutar `docker` sin sudo (estar en el
grupo `docker`), o el `available` saldrá `false`.

### Historial de fases

| Commit (head) | Fase | Qué entrega                                             |
|---------------|------|---------------------------------------------------------|
| `7340e28`     | F1   | Renombrar Desarrollo→Proyectos, `.panel.json` + Linear por proyecto |
| `e122de6`     | F3   | Mapa 3D Three.js (proyectos = ciudades) (deprecated en F7) |
| `40a6999`     | F4   | Interior por proyecto con barrios por rol (deprecated en F7)|
| `36aac96`     | F5   | Edificios temáticos + star topology + schema v3 (deprecated en F7)|
| `be14977`     | F6/F7| Reset a 2D simple — grid HTML/CSS + polling SSH (`HEALTH_CACHE`)|
| `f0c713a`     | F7.x | Fix `ssh_key`→`identity_file` + mini-mapa SVG por card  |
| `63db3a7`     | F8   | Drill-in por VPS + probes por kind + alertas en panel    |
| `7f1989d`     | F8.1 | Tile por contenedor docker en vista detalle              |
| `9825632`     | F8.2 | Filtrar running + agrupar por rol semántico              |
| `b8d95db`     | F8.3 | Cada container running es un nodo (mismo estilo que n8n) |
| `addef7d`     | F8.4 | Topología SVG + sub-columnas testing/stg por sección     |
| `5241bba`     | F8.5 | Pre-carga de containers en grid + topología expandida    |
| `f7f2400`     | F8.5 | Fix undefined/solapamiento en topología                  |
| `0715628`     | F8.6 | Un nodo por categoría + drawer con env-columns           |

Specs en `docs/superpowers/specs/`, planes en `docs/superpowers/plans/`.
