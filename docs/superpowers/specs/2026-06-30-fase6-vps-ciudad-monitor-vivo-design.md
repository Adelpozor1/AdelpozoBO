# Fase 6 — VPS = ciudad + monitorización real en vivo + carreteras dinámicas

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

Las Fases 3-5 entregaron el mapa 3D como home del panel, con un modelo donde cada **proyecto** era una ciudad, los servicios se mostraban como primitivas/edificios temáticos dentro, y las "métricas" eran mock animado.

Tras verificación en local, el usuario pidió **rediseñar el modelo**: ahora cada **VPS** es una ciudad propia (no cada proyecto), y las **carreteras** que conectan la VPS con los servicios alojados son **dinámicas** según el estado real del monitor — si el VPS está sano la carretera se ve activa, si está caído se ve roja. **Iconos de avería** (🟢/⚠️/⛔) sobre cada edificio reflejan el estado. SaaS (GitHub, Linear, Chatwoot SaaS) se asocian como **satélites** a la VPS que los usa.

La Fase 6 implementa esa visión con un **alcance mínimo deliberado**: monitor real **solo para VPS** (reusa la infraestructura SSH que ya existe en el backend para la pestaña Monitorización). Los servicios alojados (n8n, docker, postgres, etc.) siguen con mock en F6 — su monitor real se desglosa en F7-F9 kind a kind.

## Decisiones tomadas durante el brainstorming

1. **Modelo de datos**: mantener jerarquía `cliente/proyecto/services` actual. Una VPS sigue siendo un service con `kind === "vps"` dentro de su proyecto. Para indicar alojamiento, los services no-VPS llevan `config.on_host = <vps-id>`. Para satélites SaaS, `config.satellites_of = <vps-id>`. Cero migración. Restricción: service y host/satellite-of deben estar en el MISMO proyecto.
2. **Agrupación en world**: cada **cliente** = una **región** del mapa (footprint plano coloreado). Dentro de su región, las VPSs del cliente se distribuyen en grid auto, una ciudad por VPS, independientemente del proyecto en que vivan.
3. **Alcance de monitor real**: solo **VPS** en F6. Resto kinds = mock. F7+ va añadiendo kinds reales uno a uno.
4. **Polling**: backend daemon thread, cada 30s itera todos los `.panel.json` y chequea VPSs vía SSH (reusa `ssh_run` + `build_collector` + `parse_report` existentes). Caché en memoria, endpoint `/api/projects/health`.
5. **Carreteras vivas**: 3 estados (`ok`/`warn`/`down`) reflejados como color (azul/ámbar/rojo). NO se ocultan en down — siguen visibles pero coloreadas, para que veas la estructura del proyecto.
6. **Iconos avería**: emojis CSS2D (`🟢/⚠️/⛔`) flotando arriba de cada label de zona.
7. **Sin tests automatizados** (mismo criterio F1-F5).

## Sección 1 — UX y alcance

### World view

- Hoy (F3-F5): cada proyecto = una ciudad cluster.
- F6: cada **VPS** = una ciudad propia. Si un proyecto tiene 2 VPSs → 2 ciudades.
- Las ciudades se agrupan en **regiones por cliente**: footprint plano coloreado sutilmente bajo todas las VPSs de un mismo cliente, con label CSS2D `Cliente: X` arriba.
- Dentro de cada región, las VPSs en grid auto.
- Services no-VPS con `config.satellites_of === <vps-id>` aparecen como **satélites pequeños** (esferas) flotando alrededor de la ciudad de esa VPS. Label `[kind] nombre`.
- Sobre cada ciudad VPS, un **icono de estado** CSS2D (`🟢/⚠️/⛔`) según health real polled.
- Interacciones (hover, click footprint, click satélite, drag, fly-to): comportamiento equivalente a F3-F5.

### Interior de una ciudad VPS

Al entrar (botón "» Entrar en la ciudad" del side panel, igual que F4-F5):

- En el centro, el **edificio temático del VPS** (ayuntamiento, escala 2) — receta F5.
- Label "ayuntamiento · NombreVPS".
- **Servicios alojados**: `services.filter(s => s.config?.on_host === vpsId)`.
- Para cada alojado, una **calle radial** (`buildStreet` de F5) en ángulo polar `2π·i/N`, con su edificio temático al final de la calle (escala 2).
- **Color de las carreteras según health del VPS**:
  - `ok` → azul (`ROAD_COLOR_OK = 0x5a8ad0`) + líneas blancas dashed.
  - `warn` → ámbar (`ROAD_COLOR_WARN = 0xf59e0b`) + dashed ámbar.
  - `down` → rojo (`ROAD_COLOR_DOWN = 0xef4444`) + dashed roja. Siguen visibles para que veas estructura.
- **Iconos avería** (`🟢/⚠️/⛔`) sobre cada edificio (incluido el ayuntamiento). En F6 todos los edificios alojados reflejan el estado del VPS (porque no tienen su propio monitor real). El ayuntamiento refleja su propio status.
- **Cables intra-ciudad** (las `connections` manuales del `.panel.json`): se mantienen, color depende del status del VPS host.

### Side panel

- **VPS**: bloque "Estado" muestra datos REALES del cache (CPU, RAM, disk, uptime, error si down). Bloque "Métricas" muestra los reales. Cartel "monitor en vivo" (en lugar del "simulado" de F4-F5).
- **Servicios alojados (no-VPS)**: bloque "Estado" sigue siendo mock como F4-F5. Cartel "datos simulados · monitor por kind disponible en F7+".
- Resto de bloques (Config, Conexiones, acciones) sin cambios.

### Formulario (pestaña Proyectos → sub-pestaña Mapa)

- Modal de creación/edición de servicio gana un selector **"Alojado en VPS"** (solo visible cuando `kind !== "vps"`).
- Opciones: VPSs del mismo proyecto + "(ninguno — SaaS / no-hostable)".
- Al guardar, el valor seleccionado se merge en `config.on_host` (sin sobreescribir otras claves del config).
- `satellites_of` NO tiene UI en F6 — se introduce a mano editando la textarea Config JSON. UI dedicada en F7+.

### Caveats F6

- Monitor real **solo para VPS**.
- Resto kinds = mock (igual que F4/F5).
- `satellites_of` se rellena a mano.
- Polling cada 30s, sin paralelizar.
- Sin histórico de métricas.

## Sección 2 — Modelo de datos

### Schema `.panel.json` bumpea a `version: 4`

Dos campos opcionales nuevos en `config` de cada servicio:

```json
{
  "version": 4,
  "world_position": { "x": 0, "z": 0 },
  "services": [
    {
      "id": "vps-7f2a",
      "kind": "vps",
      "name": "VPS Hostinger DiveAcademy",
      "config": {
        "host": "76.13.63.235",
        "user": "adelpozor",
        "port": 22,
        "ssh_key": "/Users/.../adelpozor_ssh/hostinger_diveacademy"
      },
      "position": { "x": 0, "z": 0 },
      "interior_position": { "x": 0, "z": 0 }
    },
    {
      "id": "n8n-9b41",
      "kind": "n8n",
      "name": "n8n producción",
      "config": {
        "container": "n8n_prod",
        "on_host": "vps-7f2a"
      },
      "position": { "x": 0, "z": 0 },
      "interior_position": { "x": 0, "z": 0 }
    },
    {
      "id": "gh-1234",
      "kind": "github",
      "name": "Repo principal",
      "config": {
        "repo_url": "https://github.com/...",
        "satellites_of": "vps-7f2a"
      }
    }
  ]
}
```

### Reglas

- **`config.on_host`**: id de un service con `kind === "vps"` del MISMO `.panel.json`. Opcional. Si presente y válido → service aparece en el interior de esa VPS al final de una calle radial. Si ausente → service no se renderiza en ninguna VPS.
- **`config.satellites_of`**: id de un service con `kind === "vps"` del mismo proyecto. Opcional. Si presente → service aparece como satélite (esfera) flotando alrededor de la ciudad de esa VPS en world view. Si ausente → service ignorado por el world.
- **Validación backend**: si presentes, deben referenciar id válido de un service `kind === "vps"`. Si no → 400.
- **Backwards-compat**: v1/v2/v3 sin estos campos cargan sin error; quedan como "no alojado / no satélite".
- `validate_meta_payload()` output emite `version: 4`.

### Estado en memoria del backend (NO en disco) — caché de monitor

```python
HEALTH_CACHE = {}             # vps_id → {"ts", "status", "metrics", "error"}
HEALTH_LOCK = threading.Lock()
HEALTH_POLL_INTERVAL = 30     # segundos
HEALTH_TIMEOUT = 15           # SSH timeout por VPS
```

Cache se inicializa vacío al arrancar. Se llena tras el primer ciclo de polling (puede tardar hasta 30s en aparecer datos para VPSs nuevas).

### Endpoint `GET /api/projects/health?client=&project=`

Devuelve dict `vps_id → entrada del cache` para los VPSs del proyecto:

```json
{
  "vps-7f2a": {
    "status": "ok",
    "ts": 1719831234.123,
    "metrics": {"cpu_pct": 24, "ram_pct": 65, "disk_pct_max": 38, "uptime_s": 432000},
    "error": null
  },
  "vps-3680": {
    "status": "down",
    "ts": 1719831234.456,
    "metrics": null,
    "error": "ssh: timeout"
  }
}
```

Para VPSs sin datos aún en cache (no han pasado por el primer poll), devuelve placeholder `{ts: 0, status: "down", metrics: null, error: "sin datos todavía (esperando primer poll)"}`.

## Sección 3 — Backend (polling + caché + endpoint health)

### Polling loop daemon

```python
def health_poll_loop():
    while True:
        try:
            for client_dir in PROJECTS.iterdir():
                if not client_dir.is_dir() or not valid_name(client_dir.name):
                    continue
                for proj_dir in client_dir.iterdir():
                    if not proj_dir.is_dir() or not valid_name(proj_dir.name):
                        continue
                    try:
                        meta = load_project_meta(client_dir.name, proj_dir.name)
                    except ValueError:
                        continue
                    for s in meta.get("services", []):
                        if s.get("kind") != "vps":
                            continue
                        entry = check_vps_health(s)
                        with HEALTH_LOCK:
                            HEALTH_CACHE[s["id"]] = entry
        except Exception as e:
            print(f"[health-poll] error: {e}")
        time.sleep(HEALTH_POLL_INTERVAL)
```

Se lanza al final de `main()`:

```python
threading.Thread(target=health_poll_loop, daemon=True).start()
```

### `check_vps_health(vps_service) -> dict`

Reusa `ssh_run` + `build_collector` + `parse_report` ya existentes (los que alimentan la pestaña Monitorización para monitor.json).

```python
def check_vps_health(vps_service) -> dict:
    cfg = vps_service.get("config") or {}
    host = {
        "id": vps_service["id"],
        "name": vps_service["name"],
        "ssh_host": cfg.get("host", ""),
        "ssh_user": cfg.get("user", ""),
        "ssh_port": cfg.get("port", 22),
        "ssh_key":  cfg.get("ssh_key", ""),
    }
    ts = time.time()
    if not host["ssh_host"] or not host["ssh_user"]:
        return {"ts": ts, "status": "down", "metrics": None,
                "error": "ssh_host/ssh_user no configurados"}
    code, raw, err = ssh_run(host, build_collector(host), timeout=HEALTH_TIMEOUT)
    if code != 0:
        return {"ts": ts, "status": "down", "metrics": None,
                "error": (err or "").strip()[:200] or f"SSH exit {code}"}
    parsed = parse_report(raw, host)
    sys_block = parsed.get("system", {})
    cpu = sys_block.get("cpu_pct", 0)
    ram = (sys_block.get("memory", {}) or {}).get("used_pct", 0)
    disks = sys_block.get("disk", []) or []
    max_disk = max((d.get("used_pct", 0) for d in disks), default=0)
    status = "warn" if (cpu > 90 or ram > 90 or max_disk > 90) else "ok"
    return {"ts": ts, "status": status, "metrics": {
        "cpu_pct": cpu, "ram_pct": ram, "disk_pct_max": max_disk,
        "uptime_s": sys_block.get("uptime_s", 0),
    }, "error": None}
```

### Endpoint handler

```python
def _projects_health(self, c: str, p: str):
    if not valid_name(c) or not valid_name(p):
        return self._json(400, {"error": "nombres no válidos"})
    if safe_join(c, p) is None:
        return self._json(404, {"error": "proyecto no existe"})
    try:
        meta = load_project_meta(c, p)
    except ValueError as e:
        return self._json(500, {"error": str(e)})
    out = {}
    with HEALTH_LOCK:
        for s in meta.get("services", []):
            if s.get("kind") == "vps":
                out[s["id"]] = HEALTH_CACHE.get(s["id"]) or {
                    "ts": 0, "status": "down", "metrics": None,
                    "error": "sin datos todavía (esperando primer poll)"
                }
    self._json(200, out)
```

Wirear `/api/projects/health` en `do_GET` añadiéndolo al bloque autenticado existente que ya maneja `/api/projects/meta`.

### Validación on_host / satellites_of en `validate_meta_payload`

Tras asignar ids, antes del return:

```python
vps_ids = {s["id"] for s in out_services if s["kind"] == "vps"}
for i, s in enumerate(out_services):
    cfg = s.get("config", {})
    if not isinstance(cfg, dict):
        continue
    if "on_host" in cfg:
        if not isinstance(cfg["on_host"], str) or cfg["on_host"] not in vps_ids:
            return None, f"servicio {i}: on_host '{cfg.get('on_host')}' no es una VPS del proyecto"
    if "satellites_of" in cfg:
        if not isinstance(cfg["satellites_of"], str) or cfg["satellites_of"] not in vps_ids:
            return None, f"servicio {i}: satellites_of '{cfg.get('satellites_of')}' no es una VPS del proyecto"
```

Y bumpear el output a `version: 4`.

## Sección 4 — Frontend (rediseño world + interior + polling)

### Cambios en `map3d.js`

**Constantes nuevas:**

```javascript
const POLL_HEALTH_MS   = 30000;
const REGION_PADDING   = 4;
const SATELLITE_RADIUS = 8;
const ROAD_COLOR_OK    = 0x5a8ad0;
const ROAD_COLOR_WARN  = 0xf59e0b;
const ROAD_COLOR_DOWN  = 0xef4444;
const STATUS_ICONS     = { ok: "🟢", warn: "⚠️", down: "⛔" };
let healthCache  = new Map();
let healthTimer  = null;
let healthFetching = false;
```

**Reescritura de `buildWorld(data)`** — agrupa por cliente, dentro las VPSs como ciudades:

Pseudocódigo:
```
for each client in data.clients:
  region = buildClientRegion(client.name)
  vpsList = flatten(client.projects).filter(s => s.kind === "vps").map(s => ({...s, projectName: ...}))
  satellites = flatten(client.projects).filter(s => s.config?.satellites_of)
  layoutVPSsInGrid(vpsList) → posiciones dentro de la región
  for each vps:
    city = buildVpsCity(client, projectName, vps, healthCache.get(vps.id), satellitesForThisVps)
    region.add(city)
  worldGroup.add(region)
```

**`buildClientRegion(clientName)`** → THREE.Group con:
- Footprint plano `BoxGeometry(W, 0.1, H)` color suave por cliente (hash del nombre → color).
- Label CSS2D `Cliente: X` arriba.

**`buildVpsCity(client, project, vps, health, satellites)`** → THREE.Group con:
- Footprint plano (BoxGeometry 10×0.15×10) como F3-F5.
- Edificio temático del VPS escala 0.5 sobre el footprint.
- Label CSS2D `Cliente / Proyecto / NombreVPS` arriba.
- Icono CSS2D de status `🟢/⚠️/⛔` (clase `.status-icon`) junto al label, según health.status.
- Satélites: para cada satellite svc, una `SphereGeometry(0.3, 8, 8)` con color del kind, posicionada en órbita radio `SATELLITE_RADIUS` (ángulo `2π·i/N`). Label pequeño `[kind] nombre`.
- `userData = { type: "city-footprint", client, project, vpsId: vps.id }`.

**`buildInterior(client, project, vpsId)`** (rewrite VPS-centric):

```
vps = services.find(s => s.id === vpsId)
hosted = services.filter(s => s.config?.on_host === vpsId)

if !vps: render "VPS no encontrado" cartel
ayuntamiento = buildBuilding(vps.kind) (escala 2) en (0,0,0)
addZoneLabel + status-icon arriba del label

N = hosted.length
for i, svc of hosted:
  angle = 2π * i / N
  street = buildStreet(angle, svc.name) (color según health.status)
  building = buildBuilding(svc.kind) (escala 2)
  building.position en local (0, 0, STREET_RADIUS_START + STREET_LENGTH * 0.7)
  addZoneLabel + status-icon (compartido con el del VPS host en F6)
  street.add(building)
  g.add(street)

cables intra-ciudad como F4/F5, color según health.status
return g
```

**`pollHealth()`** (setInterval cada 30s):

```javascript
async function pollHealth() {
  if (healthFetching) return;
  healthFetching = true;
  try {
    const projectsToPoll = computeVisibleProjects(); // [(client, project)]
    for (const {client, project} of projectsToPoll) {
      const r = await fetch(`/api/projects/health?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
      if (!r.ok) continue;
      const data = await r.json();
      for (const [vpsId, entry] of Object.entries(data)) {
        healthCache.set(vpsId, entry);
      }
    }
    updateHealthVisuals();
  } catch (e) {
    console.error("pollHealth:", e);
  } finally {
    healthFetching = false;
  }
}

function startHealthPolling() {
  if (healthTimer) return;
  pollHealth(); // primer fetch inmediato
  healthTimer = setInterval(pollHealth, POLL_HEALTH_MS);
}

function stopHealthPolling() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}
```

Se arranca en `initMap3D()` después del primer `loadWorld()`. Se para nunca (mientras la pestaña Mapa esté disponible).

**`updateHealthVisuals()`**:

```
for each [vpsId, entry] in healthCache:
  // Actualizar icono de status en world
  - Find ciudad VPS por vpsId en cityMap
  - Update CSS2DObject icono con STATUS_ICONS[entry.status]
  
  // Si estamos en interior de esa VPS, actualizar colores de calles + iconos de edificios
  if sceneMode === `interior:${client}/${project}` and currentVpsId === vpsId:
    - Recorrer interiorGroup, encontrar calles + edificios
    - Actualizar materiales de calles a ROAD_COLOR_<status>
    - Actualizar iconos de cada edificio
    
markDirty()
```

### Cambios en `frontend/app.js`

Modal de servicio en el formulario Mapa (Fase 1). En la función `openSvcModal(id)`, justo después del campo `kind`, antes del campo `name`, añadir condicionalmente:

```html
<label id="onHostLabel" class="hidden">Alojado en VPS
  <select id="svcModalOnHost">
    <option value="">(ninguno — SaaS / no-hostable)</option>
    <!-- options pobladas dinámicamente con VPSs del proyecto -->
  </select>
</label>
```

Cuando `kind !== "vps"`, mostrar el label y poblar el select con VPSs del proyecto actual.

Al **Guardar**, mergear: si seleccionado, `config.on_host = value`; si no, `delete config.on_host`.

### Cambios en `map3d.css`

```css
.region-label {
  background: rgba(13, 17, 23, 0.85);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 14px;
  font-size: 13px;
  font-weight: 600;
  pointer-events: none;
}

.status-icon {
  font-size: 18px;
  filter: drop-shadow(0 0 4px rgba(0,0,0,0.6));
  pointer-events: none;
  user-select: none;
}

.satellite-label {
  background: rgba(13, 17, 23, 0.7);
  color: var(--muted);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  pointer-events: none;
}
```

## Sección 5 — Verificación, archivos y caveats

### Checklist manual

**Backend**
- [ ] Server arranca y log muestra primer ciclo de health-poll.
- [ ] Tras 30s, `GET /api/projects/health?client=DiveAcademy&project=Panel` devuelve entradas con `status`/metrics para cada VPS.
- [ ] VPS alcanzable por SSH → `status: "ok"` con métricas reales.
- [ ] VPS NO alcanzable → `status: "down"` con error legible.
- [ ] POST meta con `on_host: "vps-INEXISTENTE"` → 400 con mensaje.
- [ ] POST meta con `satellites_of` referenciando id no-VPS → 400.

**World view (frontend)**
- [ ] Agrupado por cliente: cada cliente como región con su label.
- [ ] Una ciudad por cada VPS (no por cada proyecto).
- [ ] Icono `🟢/⚠️/⛔` arriba de cada ciudad VPS según health real.
- [ ] Satélites SaaS (services con `satellites_of`): esferas pequeñas alrededor de la ciudad VPS.
- [ ] Polling actualiza iconos cada 30s sin recargar.

**Interior**
- [ ] Click footprint VPS → side panel "Entrar".
- [ ] Click "Entrar" → ayuntamiento (VPS) centro + calles radiales a hosted services.
- [ ] Calles azules si status ok, ámbar si warn, rojas si down.
- [ ] Iconos `🟢/⚠️/⛔` sobre cada edificio.
- [ ] Side panel ayuntamiento → bloque Estado con datos reales (CPU/RAM/disk/uptime).
- [ ] Side panel edificio hosted → bloque Estado mock (cartel "monitor por kind disponible en F7+").
- [ ] Esc / "← Volver al mundo" funciona como F5.

**Formulario**
- [ ] Modal de servicio kind=n8n/postgres/etc.: selector "Alojado en VPS" visible y pre-poblado.
- [ ] Modal de servicio kind=vps: selector "Alojado en VPS" oculto.
- [ ] Guardar con on_host elegido → `config.on_host` se actualiza en el `.panel.json`.

**No regresiones**
- [ ] Pestaña Linear/Monitor/Proyectos siguen idénticas.
- [ ] Sub-pestaña Mapa del formulario Fase 1 sigue funcionando (servicios + conexiones + token Linear).
- [ ] `.panel.json` v3 cargan sin error (backwards-compat).

### Archivos a tocar

**Modificar:**
- `backend/server.py` (~+150 líneas: polling thread + cache + check_vps_health + endpoint + validación + bumpear version 4).
- `frontend/map3d.js` (~+500 líneas: rewrite buildWorld + nuevas funciones buildClientRegion / buildVpsCity / buildSatellite + rewrite buildInterior VPS-centric + pollHealth + updateHealthVisuals + healthCache).
- `frontend/map3d.css` (~+30 líneas: region-label, status-icon, satellite-label).
- `frontend/app.js` (~+30 líneas: selector "Alojado en VPS" en modal de servicio).

**Crear:**
- `docs/superpowers/specs/2026-06-30-fase6-vps-ciudad-monitor-vivo-design.md` (este spec).
- `docs/superpowers/plans/2026-06-30-fase6-vps-ciudad-monitor-vivo-plan.md` (tras aprobación).

### Caveats explícitos (lo que NO entra en F6)

1. **Monitor real para n8n/docker/postgres/chatwoot/github/linear/custom**: NO. Mock. Cada uno llega como su propia fase.
2. **`satellites_of` UI**: se rellena a mano en JSON. UI dedicada en F7.
3. **Histórico de métricas**: NO. Solo el último valor en memoria.
4. **Polling paralelo**: NO. Loop síncrono. Si tienes >10 VPSs, el ciclo puede tardar.
5. **Auto-detect satellites_of** (deducir de config): NO. Manual.
6. **Sub-componentes por VPS** (CPU/RAM como zonas independientes): NO.
7. **Drag-to-rearrange en interior**: NO (sigue del F5).
8. **Animaciones de tráfico en cables**: NO.
9. **WebSocket / SSE streaming de health**: NO. Polling HTTP cada 30s.

### Fases siguientes apuntadas

- **F7**: monitor real para n8n + docker (los más comunes en stacks self-hosted) + UI para `satellites_of` en el modal.
- **F8**: monitor real para postgres + chatwoot.
- **F9**: monitor real para SaaS (github, linear).
- **F10**: histórico de métricas en SQLite + gráficas en side panel.
- **F11**: animaciones de tráfico en carreteras según métricas reales.
