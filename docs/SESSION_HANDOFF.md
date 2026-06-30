# Prompt de contexto para una nueva sesión

> Pega este archivo (o usa `cat docs/SESSION_HANDOFF.md` y luego enviámelo) al
> empezar una nueva conversación con Claude Code en este repo. Está pensado
> para que un agente fresco entienda el estado actual sin tener que leer todo
> el historial de commits.

---

## Tú eres Claude Code trabajando en este repo

**Repo**: `github.com/Adelpozor1/AdelpozoBO` — clonado en
`/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/` (Mac del usuario).

**Branch de trabajo**: `main` (el usuario commitea y pushea desde main; no
hay PRs).

**Stack inviolable**:
- Backend: **Python stdlib only** (sin pip, sin frameworks).
  `subprocess`, `json`, `threading`, `time`, `base64`, `urllib`, `http.server`.
- Frontend: **vanilla HTML+CSS+JS** sin build, sin framework, sin Three.js
  (se intentó en F3–F5 y se descartó en F7). Sin importmap. SVG inline para
  topología y mini-grafo de FKs.
- Servir el frontend desde el backend (mismo origen → cookie de sesión sin
  CORS).

**Política del usuario (recurrente, no preguntar)**:
- Un único commit por fase grande, al final. Sin commits intermedios mientras
  ejecutas el plan. Cada task verifica (curl/browser) pero no commitea.
- Sin tests automatizados (no hay framework). Verificación manual.
- Flujo: **brainstorming → spec → plan → execute**. Skills viven en
  `~/.claude/skills/`. Specs en `docs/superpowers/specs/`, planes en
  `docs/superpowers/plans/`.
- El usuario aprueba el spec antes de pasar al plan, y el plan antes de
  ejecutar.
- Lenguaje del usuario: castellano informal, mensajes cortos. Responde igual.

---

## Cómo levantar el panel local

```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend"
nohup python3 server.py > /tmp/panel.log 2>&1 &
# Escucha en 127.0.0.1:8788 (puerto sobreescrito en backend/panel.conf)
```

**Credenciales locales** (panel.conf, 2FA off para desarrollo):
- URL: `http://127.0.0.1:8788`
- Password: `uqTFZdDp5YOHPj8N`

```bash
# Login por curl (cookie en /tmp/cookies.txt):
curl -s -c /tmp/cookies.txt -X POST http://127.0.0.1:8788/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"uqTFZdDp5YOHPj8N"}'
# Resto de llamadas:
curl -s -b /tmp/cookies.txt http://127.0.0.1:8788/api/world
```

**Datos sandbox**: el `projects_dir` apunta a un scratchpad temporal:
```
/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/<sessionId>/scratchpad/panel-projects/
```
Cliente: `DiveAcademy`, proyecto: `Panel`. Tiene servicios declarados
(VPS Hostinger, VPS LAN, n8n alojado, satélite GitHub).

## VPS de pruebas (real)

- **Hostinger DiveAcademy**: `72.61.163.130` (user `adelpozor`, key
  `~/.ssh/adelpozor_ssh/hostinger_diveacademy`). **TIENE EasyPanel + 30
  contenedores docker (13 running)**: backoffices testing+staging, frontoffice
  testing+staging, chatwoot completo (main + sidekiq + db + redis), n8n,
  postgres global, easypanel, traefik. **"testing" es PRODUCCIÓN** según el
  usuario (no confundir).
- **VPS LAN 192.168.1.29**: declarada pero sin probada. Probablemente
  inaccesible si no estás en la red local.
- Antes la `vps-74aa` apuntaba a `76.13.63.235` que era la VPS de gestión del
  propio panel (sin docker). Migrada a 72.61.163.130 en F8.

## Estructura del backend (`backend/server.py`, ~2900 líneas)

Bloques clave (busca por comentario `# ===`):

- L1–250: imports, config, totp, sesiones, helpers de path
- L300–420: `meta_path`, `load_project_meta`, `save_project_meta`,
  `alerts_path`, `load_alerts`, `save_alerts`, `validate_alerts_payload`
- L430–610: `validate_meta_payload` (schema v5: bumpear cuando añadas campos)
- L750–1015: `ssh_run`, `build_collector`, `parse_report` (recolector único
  para health + monitor view legacy)
- L1019–1090: F6 — `HEALTH_CACHE`, `check_vps_health`, `health_poll_loop`
  (daemon thread, intervalo 30s)
- L1092–1500: F8 — probes (`probe_vps`, `probe_n8n`, `probe_postgres`,
  `probe_container_logs`), `DETAIL_CACHE` (TTL 15s),
  `get_service_detail`, `get_container_detail`, `ALERT_STATE`,
  `_eval_rule`, `evaluate_alerts` (engachado al `health_poll_loop`)
- L1700+: `Handler(BaseHTTPRequestHandler)` con todos los endpoints

Endpoints HTTP (auth requerida menos `/api/whoami`, `/api/login`):

```
GET  /api/whoami
GET  /api/world                                       → árbol cliente/proyecto/services
GET  /api/projects/health?client&project
GET  /api/services/detail?client&project&service      → probe por kind
GET  /api/services/container?client&project&vps&container  → probe container raw
GET  /api/projects/alerts?client&project
POST /api/projects/alerts                             → body { client, project, rules }
GET  /api/alerts/active
GET  /api/monitor/hosts, GET /api/monitor/report?host=…  → legacy F0
POST /api/projects/{create,delete,rename,meta,linear-token}
POST /api/repos/{clone,pull,checkout,delete,rename}
POST /api/chat                                         → streaming NDJSON al CLI claude
```

## Estructura del frontend

- `frontend/index.html` — slot `#alerts-banner` (F8), `#map-home` (grid +
  `#vps-detail-view`), `#main-row` con tabs `Repos / Mapa / Alertas`
- `frontend/app.js` (~1400 líneas) — login, navegación, formularios de
  proyectos/repos/mapa, **tab Alertas (F8)** (`enterAlertsTab`,
  `renderAlertsTab`, `showAlertForm`, `saveAlerts`)
- `frontend/map2d.js` (~900 líneas) — toda la lógica del Mapa (F7 + F8). Ver
  sección abajo.
- `frontend/map2d.css` — estilos del mapa, banner alertas, drawer, env badges
- `frontend/styles.css` — el resto

### `map2d.js` — funciones clave

| Función | Responsabilidad |
|---------|-----------------|
| `loadAndRender` | Fetch /api/world + health + alertas + dispara `fetchAllVpsDetails` en background |
| `fetchAllVpsDetails` | Pre-carga `/api/services/detail` para cada VPS → `vpsDetailCache` |
| `renderGrid` | Cards por cliente con mini-map por VPS |
| `renderVpsCard` | Card individual: header, métricas, mini-map, expand |
| `classifyContainer(name)` | regex → `{env: testing/staging/global, role: backoffice/n8n/db/...}` |
| `buildTopologyNodes(vps, hosted)` | Lista de nodos per container (running + declarados sin container) |
| `buildRoleAggregates(vps, hosted)` | Agrega por rol → un nodo por categoría |
| `renderTopologySVG(aggregates, …, {preview})` | SVG con VPS centro + nodos por categoría. Preview = dots; detail = rects |
| `renderMiniCityMap` | Wrapper para preview en grid |
| `renderHostedServicesSection` | Sección del detalle: topology + leyenda + nota |
| `renderVpsDetailView` | Toda la pantalla detalle (header + topology + drawer) |
| `openServiceDrawer(id)` | Fetch /api/services/detail y render por kind |
| `openContainerDrawer(name)` | Fetch /api/services/container y render logs |
| `openRoleDrawer(roleKey)` | Lista contenedores de un rol con env-columns |
| `renderVpsDrawer/N8nDrawer/PostgresDrawer/LogsDrawer/SaasDrawer` | Renderers kind-specific |

Estado global:
- `mapData` (último /api/world)
- `healthCache` Map (vpsId → {status, metrics, ...})
- `vpsDetailCache` Map (vpsId → /api/services/detail response)
- `activeAlerts` array
- `viewMode` "grid"|"detail"
- `detailVpsId`, `detailServiceId`, `detailContainerName`, `detailRoleKey`
  (qué hay abierto en la vista/drawer)

### Constantes importantes

```js
CONTAINER_ROLE_GROUPS = [backoffice, frontoffice, chatwoot, n8n, db, cache, proxy, infra, other]
// Cada uno con { key, label, color }
ALERT_KINDS_UI = [...] // 6 tipos, ver UI tab Alertas
```

## Lo último que hicimos (orden cronológico)

1. **F1** — formulario de servicios por proyecto (`.panel.json`), Linear token por proyecto
2. **F3, F4, F5** — versiones 3D con Three.js (descartadas)
3. **F6 + F7** — pivote a 2D simple: grid + cards + polling SSH backend daemon
4. **F7.x** — fix path SSH key + mini-mapa SVG en cada card
5. **F8** — drill-in completo: probes por kind, alertas, drawer por servicio
6. **F8.1–F8.6** — iteraciones de UX del detail view:
   - 8.1: tiles por container docker en el detalle
   - 8.2: filtrar running + agrupar por rol
   - 8.3: unificar declarados + descubiertos como mismo tipo de tile
   - 8.4: topología SVG arriba + sub-columnas testing/stg en cards abajo
   - 8.5: pre-carga de containers en grid + cada container como nodo en detalle
   - 8.5 fix: bug "undefined" por function hoisting de dos `renderTopologySVG`
   - 8.6: **agregar por categoría** → un nodo por rol (no por container) + drawer con env-columns

Estado actual: F8.6 commiteada en main. Branch local sincronizado con
`origin/main` (asumiendo que se hizo `git push` después de F8.6).

## Cosas pendientes / known issues

- El VPS LAN 192.168.1.29 está declarado pero nunca probado en vivo.
- Las alertas viven en memoria (`ALERT_STATE`) — al reiniciar el backend se
  reconstruye el estado en el primer poll. Por diseño (decisión del usuario:
  solo panel, no Telegram/email).
- `probe_postgres` cap a 200 tablas / 2000 columnas para no reventar el JSON
  en bases grandes. Marca `schema.truncated: true`.
- Si docker no está disponible (user no en grupo docker), la sección
  "Contenedores Docker" muestra un mensaje claro y la topología muestra solo
  los servicios declarados.
- El cliente `test-client/test-project` del sandbox tiene servicios mock.
  El cliente real es `DiveAcademy/Panel`.

## Cosas que el usuario te dirá y conviene anticipar

- "Para mí testing es producción" — no le corrijas la nomenclatura.
- "Refresca el navegador" significa Cmd+Shift+R (hard reload) — los assets se
  sirven con `Cache-Control: no-cache, must-revalidate` pero a veces el SW del
  navegador se queda con código viejo.
- Si pide "pushea a main", solo haz `git push origin main` después de
  verificar con `git status` y `git log --oneline -5` que es lo esperado.
  NUNCA force push.

## Comandos útiles para diagnóstico

```bash
# Reiniciar backend local:
pkill -f "python3 server.py"
(cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && nohup python3 server.py > /tmp/panel.log 2>&1 &)

# Login + probar endpoint nuevo:
curl -s -c /tmp/cookies.txt -X POST http://127.0.0.1:8788/api/login -H 'Content-Type: application/json' -d '{"password":"uqTFZdDp5YOHPj8N"}'
curl -s -b /tmp/cookies.txt "http://127.0.0.1:8788/api/services/detail?client=DiveAcademy&project=Panel&service=vps-74aa" | python3 -m json.tool

# Lista de contenedores de la VPS real:
ssh -i ~/.ssh/adelpozor_ssh/hostinger_diveacademy adelpozor@72.61.163.130 'docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"'
```

---

## Cómo proceder cuando el usuario pida algo nuevo

1. Si es **una feature**: invoca `brainstorming` skill → spec en
   `docs/superpowers/specs/YYYY-MM-DD-<nombre>-design.md` → commit `docs(faseX): spec`.
2. Luego `writing-plans` skill → plan en `docs/superpowers/plans/`. No
   commits intermedios; el plan acaba con un único commit `feat(faseX): …`.
3. Si es **un fix pequeño**: ve directo al fix, un único commit `fix(...): ...`.
4. Si es **una pregunta**: responde en castellano informal, sin sobre-explicar.

**Antes de cualquier commit**: `git status`, `git diff --stat`, verificar
syntax con `python3 -c "import ast; ast.parse(open('backend/server.py').read())"`
y `node -c frontend/map2d.js` (o `app.js`).

Mensaje de commit en castellano, con `Co-Authored-By: Claude Opus 4.7 …`.
