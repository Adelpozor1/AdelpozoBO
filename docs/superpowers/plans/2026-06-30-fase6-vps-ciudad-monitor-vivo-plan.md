# Fase 6 — VPS=ciudad + monitor real en vivo — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rediseñar el mapa 3D para que cada VPS sea una ciudad propia (no cada proyecto), agruparlas por cliente en regiones, y conectar el ayuntamiento (VPS) con sus servicios alojados (`config.on_host = vps-id`) mediante calles radiales cuyo color refleja el estado real del monitor (azul ok / ámbar warn / rojo down). Backend polling daemon cada 30s reusa el SSH existente para chequear todas las VPSs y exponer `/api/projects/health`. Iconos emoji (🟢/⚠️/⛔) sobre cada edificio. Satélites SaaS opcionales con `config.satellites_of`.

**Architecture:** Backend `backend/server.py` añade ~150 líneas (thread polling + cache + endpoint + validación). Frontend `frontend/map3d.js` se reescriben las funciones `buildWorld` y `buildInterior` (~+500 líneas) reemplazando el modelo proyecto=ciudad de F3-F5 por VPS=ciudad. `vpsCityMap` (keyed por vpsId) reemplaza el viejo `cityMap` (keyed por client/project). Frontend hace polling HTTP cada 30s y `updateHealthVisuals()` refresca colores/iconos sin reconstruir la escena. `frontend/app.js` añade un selector "Alojado en VPS" al modal del formulario Fase 1.

**Tech Stack:** Python 3 stdlib (backend, sin nuevas deps), JavaScript ES modules vanilla, Three.js 0.160.0 self-hosted (sin cambios), HTML5 + CSS3.

**Spec de referencia:** `docs/superpowers/specs/2026-06-30-fase6-vps-ciudad-monitor-vivo-design.md` (commit `37b2c80`).

**Política de commits:** **Un único commit al final** (Task 8). Cada task verifica (curl/browser) pero NO commitea.

---

## File structure

**Modificados:**

- `backend/server.py` — añade constantes `HEALTH_CACHE`, `HEALTH_LOCK`, `HEALTH_POLL_INTERVAL`, `HEALTH_TIMEOUT`; nuevo helper `check_vps_health(vps_service)`; daemon `health_poll_loop()`; handler `_projects_health(c, p)`; ruta `/api/projects/health` en `do_GET`; validación de `on_host`/`satellites_of` en `validate_meta_payload`; bumpear output a `version: 4`; arrancar el thread daemon al final de `main()`.
- `frontend/map3d.js` — reemplaza `cityMap` por `vpsCityMap` (keyed por vpsId); reescribe `buildWorld`; nuevas funciones `buildClientRegion`, `buildVpsCity`, `buildSatellite`, `pollHealth`, `updateHealthVisuals`, `startHealthPolling`, `stopHealthPolling`; reescribe `buildInterior` (signature nueva `(client, project, vpsId)`); modifica `enterCity` (signature nueva `(client, project, vpsId)`); modifica `openCityPanel` para pasar `vpsId` al botón Entrar; adapta `persistDragged`/`rebuildCity`/`deleteZoneFromPanel` a `vpsCityMap`.
- `frontend/map3d.css` — añade `.region-label`, `.status-icon`, `.satellite-label`.
- `frontend/app.js` — modifica `openSvcModal` para añadir selector "Alojado en VPS" cuando `kind !== "vps"`; pobla con VPSs del proyecto; merge en `config.on_host` al guardar.

**Creados:**

- `docs/superpowers/plans/2026-06-30-fase6-vps-ciudad-monitor-vivo-plan.md` (este documento).

**Sin tocar:** `frontend/index.html`, `frontend/styles.css`, `frontend/vendor/*`, `backend/panel.conf`, `.gitignore`.

---

## Task 1: Backend — Schema v4 (validación on_host + satellites_of)

**Files:**
- Modify: `backend/server.py` (extender `validate_meta_payload`, bumpear version a 4)

- [ ] **Step 1: Extender `validate_meta_payload` con validación cruzada**

Localizar `validate_meta_payload()` en `backend/server.py` (la versión actual emite `version: 3` y valida `world_position` + `position` + `interior_position`). **Tras el bucle que construye `out_services`**, antes del `return {...}` final, **añadir el bloque de validación cruzada**:

```python
    # Validación cruzada Fase 6: on_host y satellites_of deben referenciar
    # un id de service con kind=vps presente en el mismo payload
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

Y **modificar el return final** para emitir `version: 4`:

```python
    return {
        "version": 4,
        "world_position": world_position,
        "services": out_services,
        "connections": out_connections,
    }, ""
```

- [ ] **Step 2: Reiniciar server y verificar con curl**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
echo "== POST con on_host válido =="
# Primero capturar vps_id de un service kind=vps existente:
VPSID=$(curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=DiveAcademy&project=Panel" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((s['id'] for s in d['services'] if s['kind']=='vps'), ''))")
echo "VPSID=$VPSID"
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d "{\"client\":\"DiveAcademy\",\"project\":\"Panel\",\"services\":[
    {\"id\":\"$VPSID\",\"kind\":\"vps\",\"name\":\"VPS Hostinger DiveAcademy\",\"config\":{\"host\":\"76.13.63.235\",\"user\":\"adelpozor\"}},
    {\"kind\":\"n8n\",\"name\":\"n8n test\",\"config\":{\"on_host\":\"$VPSID\"}}
  ],\"connections\":[]}" | python3 -m json.tool | grep -E "version|on_host" | head -5
echo "== POST con on_host inválido =="
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"DiveAcademy","project":"Panel","services":[{"kind":"n8n","name":"x","config":{"on_host":"vps-INEXISTENTE"}}],"connections":[]}'
echo
echo "== POST con satellites_of válido =="
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d "{\"client\":\"DiveAcademy\",\"project\":\"Panel\",\"services\":[
    {\"id\":\"$VPSID\",\"kind\":\"vps\",\"name\":\"VPS Hostinger DiveAcademy\",\"config\":{\"host\":\"76.13.63.235\",\"user\":\"adelpozor\"}},
    {\"kind\":\"github\",\"name\":\"repo\",\"config\":{\"satellites_of\":\"$VPSID\"}}
  ],\"connections\":[]}" | python3 -c "import json,sys;d=json.load(sys.stdin);print('version:',d.get('version'));print('services:',[(s['kind'],s.get('config',{}).get('on_host'),s.get('config',{}).get('satellites_of')) for s in d.get('services',[])])"
```

Expected:
- POST con on_host válido: respuesta `version: 4`, service n8n con `on_host` persistido al VPSID.
- POST con on_host inválido: `{"error": "servicio 0: on_host 'vps-INEXISTENTE' no es una VPS del proyecto"}`.
- POST con satellites_of válido: `version: 4`, service github con `satellites_of: VPSID`.

- [ ] **Step 3: Checkpoint** — Schema v4 con validación cruzada operativo.

---

## Task 2: Backend — Health polling + caché + endpoint

**Files:**
- Modify: `backend/server.py` (constantes nuevas, check_vps_health, health_poll_loop, _projects_health, wire en do_GET, arranque del thread en main)

- [ ] **Step 1: Añadir constantes y helpers**

Editar `backend/server.py`. **Localizar la función `parse_report`** (la del bloque de monitor existente). **Justo después** de `parse_report` (o al final de ese bloque de monitor, antes de la línea `# ----` de la siguiente sección), añadir:

```python
# ============================================================ #
# Fase 6 — Health polling de VPSs                               #
# ============================================================ #
HEALTH_CACHE = {}              # vps_id → {"ts", "status", "metrics", "error"}
HEALTH_LOCK = threading.Lock()
HEALTH_POLL_INTERVAL = 30      # segundos
HEALTH_TIMEOUT = 15            # SSH timeout por VPS


def check_vps_health(vps_service: dict) -> dict:
    """Chequea una VPS por SSH (reusa ssh_run + build_collector + parse_report).
    Devuelve {ts, status, metrics, error}. status ∈ {"ok","warn","down"}."""
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
        msg = (err or "").strip()[:200] or f"SSH exit {code}"
        return {"ts": ts, "status": "down", "metrics": None, "error": msg}
    parsed = parse_report(raw, host)
    sys_block = parsed.get("system", {})
    cpu = sys_block.get("cpu_pct", 0) or 0
    mem = sys_block.get("memory", {}) or {}
    ram = mem.get("used_pct", 0) or 0
    disks = sys_block.get("disk", []) or []
    max_disk = max((d.get("used_pct", 0) for d in disks), default=0)
    status = "warn" if (cpu > 90 or ram > 90 or max_disk > 90) else "ok"
    return {"ts": ts, "status": status, "metrics": {
        "cpu_pct": cpu,
        "ram_pct": ram,
        "disk_pct_max": max_disk,
        "uptime_s": sys_block.get("uptime_s", 0),
    }, "error": None}


def health_poll_loop():
    """Daemon thread que cada HEALTH_POLL_INTERVAL segundos chequea todas las
    VPSs declaradas en cualquier proyecto y actualiza HEALTH_CACHE."""
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

- [ ] **Step 2: Añadir handler `_projects_health`**

Localizar el handler `_proj_meta_get` en la clase `Handler`. **Inmediatamente después** de ese handler (o cerca, en la sección de handlers de proyectos), añadir:

```python
    def _projects_health(self, c: str, p: str):
        """Devuelve el cache de health para todas las VPSs del proyecto c/p."""
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

- [ ] **Step 3: Wirear `/api/projects/health` en `do_GET`**

Localizar el bloque autenticado de `do_GET` que ya maneja `/api/projects/meta` (Fase 1). El `elif path in (...)` actual incluye varios paths. **Sustituir** ese `elif` para incluir el nuevo path:

Buscar:
```python
        elif path in ("/api/clients", "/api/projects", "/api/repos",
                      "/api/repos/branches", "/api/projects/meta", "/api/world"):
```

**Reemplazar por:**
```python
        elif path in ("/api/clients", "/api/projects", "/api/repos",
                      "/api/repos/branches", "/api/projects/meta", "/api/world",
                      "/api/projects/health"):
```

Y dentro del cuerpo de ese bloque, **añadir** un elif para dispatchar:
```python
            elif path == "/api/projects/health":
                self._projects_health(q.get("client", [""])[0], q.get("project", [""])[0])
```

Posicionarlo justo después del `elif path == "/api/world": self._world_get()`.

- [ ] **Step 4: Arrancar el daemon thread en `main()`**

Localizar la función `main()` al final de `backend/server.py`. **Justo antes de `httpd.serve_forever()`**, añadir:

```python
    # Fase 6: lanzar polling daemon de health
    threading.Thread(target=health_poll_loop, daemon=True).start()
    print("[health-poll] daemon iniciado (cada 30s)")
```

- [ ] **Step 5: Reiniciar server y verificar polling**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
grep "health-poll" /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log
echo "== GET /api/projects/health (puede dar 'sin datos todavía' inicialmente) =="
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/health?client=DiveAcademy&project=Panel" | python3 -m json.tool
echo "== Esperando 30s para que el daemon haga su primer ciclo =="
sleep 32
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/health?client=DiveAcademy&project=Panel" | python3 -m json.tool
```

Expected:
- Log inicial muestra `[health-poll] daemon iniciado (cada 30s)`.
- Primer GET (antes de los 30s): cada VPS con `status: "down", error: "sin datos todavía..."`.
- Tras 32s: cada VPS con `status: "ok"` (si SSH funciona) o `status: "down"` con error real (si no es alcanzable desde tu Mac, p. ej. red, clave). Lo importante es que el endpoint responde con la estructura nueva.

- [ ] **Step 6: Checkpoint** — Polling daemon corriendo, endpoint health operativo.

---

## Task 3: Frontend — buildWorld + buildClientRegion + buildVpsCity + buildSatellite

**Files:**
- Modify: `frontend/map3d.js` (reescribir buildWorld + añadir nuevas funciones; reemplazar cityMap por vpsCityMap; eliminar/dejar legacy buildCity + buildCityCluster)

- [ ] **Step 1: Renombrar `cityMap` → `vpsCityMap` y limpiar referencias previas**

Localizar la declaración `const cityMap = new Map();` cerca del inicio del archivo (después del bloque de constantes de zona). **Reemplazar** por:

```javascript
const vpsCityMap = new Map();   // vpsId → { client, project, vps, group, footprint, label, buildingMesh, satellites: Map<svcId,mesh>, statusIcon }
const cityMap = vpsCityMap;     // Alias legacy temporal para funciones que aún lo referencian (a limpiar en F7)
```

(El alias `cityMap = vpsCityMap` se mantiene durante F6 porque `updateCablesForZone`, `rebuildCity`, etc. todavía lo usan internamente. La estructura interna del valor cambia — ver siguiente step.)

- [ ] **Step 2: Reescribir `buildWorld(data)` y eliminar el viejo `buildCity` por dentro**

Localizar la función `buildWorld(data)`. La versión actual itera `data.clients → projects → buildCity(client, project, meta, worldPos)`. **Reemplazar** la función completa por:

```javascript
function buildWorld(data) {
  clearWorld();
  // Cada cliente = una región. Dentro de cada región se distribuyen las VPSs del cliente
  // como ciudades, independientemente del proyecto.
  const clients = data.clients || [];
  const N = clients.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(N)));

  let regionIndex = 0;
  for (const cli of clients) {
    // Recoger todas las VPSs y servicios satélites del cliente
    const vpsItems = [];        // [{vps, client, project}]
    const allServicesByProject = []; // [{project, services[]}]
    for (const proj of cli.projects || []) {
      const services = (proj.meta && proj.meta.services) || [];
      allServicesByProject.push({ project: proj.name, services });
      for (const s of services) {
        if (s.kind === "vps") vpsItems.push({ vps: s, client: cli.name, project: proj.name });
      }
    }
    // Satélites: services del cliente con config.satellites_of
    const satellitesByVps = new Map();
    for (const { project, services } of allServicesByProject) {
      for (const s of services) {
        const targetVps = s.config && s.config.satellites_of;
        if (!targetVps) continue;
        if (!satellitesByVps.has(targetVps)) satellitesByVps.set(targetVps, []);
        satellitesByVps.get(targetVps).push({ svc: s, project });
      }
    }

    const region = buildClientRegion(cli.name, vpsItems.length, regionIndex, cols);
    const regionRoot = region.userData.root;     // donde colgar las ciudades

    // Distribuir VPSs en grid dentro de la región
    const Nv = vpsItems.length;
    const vCols = Math.max(1, Math.ceil(Math.sqrt(Nv)));
    vpsItems.forEach((item, idx) => {
      const row = Math.floor(idx / vCols);
      const col = idx % vCols;
      const spacing = 14;
      const lx = (col - (vCols - 1) / 2) * spacing;
      const lz = (row - (Math.ceil(Nv / vCols) - 1) / 2) * spacing;
      const satellites = satellitesByVps.get(item.vps.id) || [];
      const cityGroup = buildVpsCity(item.client, item.project, item.vps,
                                     healthCache.get(item.vps.id), satellites);
      cityGroup.position.set(lx, 0, lz);
      regionRoot.add(cityGroup);
    });

    worldGroup.add(region);
    regionIndex++;
  }

  // Empty state
  const empty = clients.every(c => (c.projects || []).every(p => !((p.meta && p.meta.services) || []).some(s => s.kind === "vps")));
  const overlay = container.querySelector("#mapEmptyState");
  if (overlay) overlay.classList.toggle("hidden", !empty);
}
```

- [ ] **Step 3: Implementar `buildClientRegion(clientName, vpsCount, regionIndex, totalCols)`**

**Al final del archivo `map3d.js`** añadir (mantén las funciones existentes intactas):

```javascript
function buildClientRegion(clientName, vpsCount, regionIndex, totalCols) {
  const group = new THREE.Group();
  group.userData = { type: "client-region", client: clientName };
  // Posición de la región en grid (cada región ocupa ~40 unidades)
  const REGION_SPACING = 40;
  const row = Math.floor(regionIndex / totalCols);
  const col = regionIndex % totalCols;
  group.position.set(
    (col - (totalCols - 1) / 2) * REGION_SPACING,
    0,
    (row - 0) * REGION_SPACING
  );

  // Tamaño del footprint según número de VPSs
  const vCols = Math.max(1, Math.ceil(Math.sqrt(Math.max(vpsCount, 1))));
  const widthPad = vCols * 14 + REGION_PADDING * 2;
  const depthPad = Math.ceil(Math.max(vpsCount, 1) / vCols) * 14 + REGION_PADDING * 2;

  // Color por cliente (hash → hue)
  const h = simpleHash(clientName);
  const hue = (h % 360) / 360;
  const color = new THREE.Color().setHSL(hue, 0.35, 0.18);
  const footprint = new THREE.Mesh(
    new THREE.BoxGeometry(widthPad, 0.1, depthPad),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5 })
  );
  footprint.position.y = 0.05;
  footprint.userData = { type: "region-footprint", client: clientName };
  group.add(footprint);

  // Label CSS2D arriba
  const lblDiv = document.createElement("div");
  lblDiv.className = "region-label";
  lblDiv.textContent = "Cliente: " + clientName;
  const label = new CSS2DObject(lblDiv);
  label.position.set(0, 1.5, -depthPad / 2 - 1);
  group.add(label);

  // root: contenedor donde colgar las VPS cities (dentro de la región)
  const root = new THREE.Group();
  group.add(root);
  group.userData.root = root;
  return group;
}
```

- [ ] **Step 4: Implementar `buildVpsCity(client, project, vps, health, satellites)`**

Continuar al final del archivo:

```javascript
function buildVpsCity(client, project, vps, health, satellites) {
  const cityGroup = new THREE.Group();
  cityGroup.userData = { type: "city", client, project, vpsId: vps.id };

  // Footprint de la ciudad (igual que F5)
  const footprint = new THREE.Mesh(
    new THREE.BoxGeometry(10, 0.15, 10),
    new THREE.MeshStandardMaterial({ color: 0x202a3a })
  );
  footprint.position.y = 0.08;
  footprint.userData = { type: "city-footprint", client, project, vpsId: vps.id };
  cityGroup.add(footprint);

  // Edificio temático del VPS (escala 0.5, sobre footprint)
  const building = buildBuilding(vps.kind);
  building.scale.setScalar(CITY_CLUSTER_CENTRAL_SCALE);
  building.position.set(0, 0.15, 0);
  building.userData = { type: "zone", service: vps, client, project };
  cityGroup.add(building);

  // Label CSS2D principal de la ciudad
  const labelDiv = document.createElement("div");
  labelDiv.className = "city-label";
  labelDiv.textContent = `${client} / ${project} / ${vps.name}`;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, 2.5, 0);
  cityGroup.add(label);

  // Icono de estado (emoji) flotando junto al label
  const statusDiv = document.createElement("div");
  statusDiv.className = "status-icon";
  statusDiv.dataset.vpsId = vps.id;
  statusDiv.textContent = STATUS_ICONS[health ? health.status : "down"] || STATUS_ICONS.down;
  const statusObj = new CSS2DObject(statusDiv);
  statusObj.position.set(0, 3.2, 0);
  cityGroup.add(statusObj);

  // Satélites SaaS orbitando
  const satMap = new Map();
  satellites.forEach(({ svc }, i) => {
    const angle = (2 * Math.PI * i) / Math.max(satellites.length, 3);
    const sx = SATELLITE_RADIUS * Math.cos(angle);
    const sz = SATELLITE_RADIUS * Math.sin(angle);
    const color = ZONE_COLORS[svc.kind] || ZONE_COLORS.custom;
    const satMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 8),
      new THREE.MeshStandardMaterial({ color })
    );
    satMesh.position.set(sx, 1.5, sz);
    satMesh.userData = { type: "satellite", service: svc, client, project, vpsId: vps.id };
    cityGroup.add(satMesh);
    // Label
    const satLbl = document.createElement("div");
    satLbl.className = "satellite-label";
    satLbl.textContent = `[${svc.kind}] ${svc.name}`;
    const satObj = new CSS2DObject(satLbl);
    satObj.position.set(0, 0.5, 0);
    satMesh.add(satObj);
    satMap.set(svc.id, satMesh);
  });

  vpsCityMap.set(vps.id, {
    client, project, vps,
    group: cityGroup, footprint, label,
    buildingMesh: building, satellites: satMap, statusIcon: statusObj,
    projectMeta: null,   // ver step 5: lo rellenamos tras buildWorld con el meta del proyecto
  });
  return cityGroup;
}
```

- [ ] **Step 5: Rellenar `projectMeta` para cada vpsCityMap entry tras buildWorld**

En `buildWorld`, **al final** (después de cerrar el for de clients), añadir:

```javascript
  // Rellenar projectMeta de cada vpsCity para que rebuildCity/persistDragged
  // puedan operar (necesitan el meta completo del proyecto al que pertenece la VPS).
  for (const cli of clients) {
    for (const proj of cli.projects || []) {
      const meta = proj.meta || {};
      for (const s of meta.services || []) {
        if (s.kind !== "vps") continue;
        const rec = vpsCityMap.get(s.id);
        if (rec) rec.projectMeta = meta;
      }
    }
  }
```

- [ ] **Step 6: Eliminar (o vaciar) `buildCity` y `buildCityCluster` viejas**

Localizar `function buildCity(client, project, meta, worldPos)` y `function buildCityCluster(services, client, project)` (de F3/F5). **Reemplazar SOLO** sus cuerpos por un comentario de deprecation (mantener las firmas para no romper imports, aunque ya no se llaman):

```javascript
function buildCity(client, project, meta, worldPos) {
  // F6: deprecated. La construcción ahora es VPS-céntrica vía buildVpsCity/buildClientRegion.
  return new THREE.Group();
}
function buildCityCluster(services, client, project) {
  // F6: deprecated. Cada VPS es su propia ciudad en F6.
  return new THREE.Group();
}
```

- [ ] **Step 7: Adaptar `clearWorld()` para limpiar regiones y vpsCityMap**

Localizar la función `clearWorld()`. **Reemplazar** por:

```javascript
function clearWorld() {
  // Quitar todos los hijos del worldGroup (incluye regiones de clientes con sus ciudades VPS)
  while (worldGroup.children.length > 0) {
    const c = worldGroup.children[0];
    worldGroup.remove(c);
    disposeGroup(c);
  }
  vpsCityMap.clear();
}
```

- [ ] **Step 8: Verificación visual rápida**

Hard refresh en navegador (tras este task no vas a ver cambios completos aún porque polling/icons llegan en Task 5, pero al menos buildWorld debe ejecutar sin errores). Esperado:

- [ ] Pestaña Mapa se carga sin errores en consola.
- [ ] Por cada cliente del sandbox aparece una región con su label "Cliente: X".
- [ ] Dentro de cada región, una ciudad por cada VPS del cliente (no por cada proyecto).
- [ ] Cada VPS city tiene su edificio temático (ayuntamiento) y un label con `cliente / proyecto / nombreVPS`.
- [ ] Iconos `⛔` por defecto sobre cada ciudad (porque healthCache vacío todavía — Task 5 lo arregla).

Test:
```bash
node --check "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/map3d.js" && echo OK
```

- [ ] **Step 9: Checkpoint** — World view ya muestra VPS=ciudad agrupado por cliente.

---

## Task 4: Frontend — Reescribir `buildInterior` VPS-centric

**Files:**
- Modify: `frontend/map3d.js` (sustituir `buildInterior` y `enterCity` y `openCityPanel`)

- [ ] **Step 1: Modificar `enterCity` para recibir `vpsId`**

Localizar la función `enterCity = function(client, project) { ... }`. **Reemplazar** por:

```javascript
enterCity = function(client, project, vpsId) {
  if (!client || !project || !vpsId) return;
  if (sceneMode.startsWith("interior:")) return;

  worldCameraSnapshot = {
    position: camera.position.clone(),
    frustumSize: camera.userData.frustumSize,
  };
  savedEditModeBeforeEnter = editMode;
  if (editMode) setEditMode(false);

  worldGroup.visible = false;
  if (sidePanelOpen) closeSidePanel();

  // Inicializar mock metrics para todos los services del proyecto si faltan
  if (typeof initMockMetricsForServices === "function") {
    const rec = vpsCityMap.get(vpsId);
    if (rec && rec.projectMeta) initMockMetricsForServices(rec.projectMeta.services || []);
  }

  interiorGroup = buildInterior(client, project, vpsId);
  scene.add(interiorGroup);

  camera.position.set(50, 50, 50);
  setFrustum(INTERIOR_FRUSTUM);
  camera.lookAt(0, 0, 0);

  sceneMode = `interior:${client}/${project}/${vpsId}`;
  if (typeof showHudInterior === "function") showHudInterior(true);
  if (typeof startMockTicker === "function") startMockTicker();

  markDirty();
};
```

- [ ] **Step 2: Reescribir `buildInterior` (signature nueva con vpsId)**

Localizar `buildInterior = function(client, project) { ... }`. **Reemplazar** por:

```javascript
buildInterior = function(client, project, vpsId) {
  const g = new THREE.Group();
  g.userData = { type: "interior", client, project, vpsId };

  const cityRec = vpsCityMap.get(vpsId);
  const meta = cityRec && cityRec.projectMeta ? cityRec.projectMeta : null;
  const services = (meta && meta.services) || [];
  const vps = services.find(s => s.id === vpsId);

  if (!vps) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "interior-empty";
    emptyDiv.innerHTML = '<strong>VPS no encontrada</strong>Vuelve al mundo y prueba con otra ciudad';
    const emptyLabel = new CSS2DObject(emptyDiv);
    emptyLabel.position.set(0, 1, 0);
    g.add(emptyLabel);
    return g;
  }

  // Mapa interno serviceId → mesh, para construir cables al final
  const interiorZoneMeshes = new Map();
  g.userData.interiorZoneMeshes = interiorZoneMeshes;

  // Status del VPS para colorear carreteras
  const vpsHealth = healthCache.get(vpsId);
  const status = (vpsHealth && vpsHealth.status) || "down";
  const roadColor = status === "warn" ? ROAD_COLOR_WARN
                  : status === "down" ? ROAD_COLOR_DOWN
                  : ROAD_COLOR_OK;

  // === AYUNTAMIENTO (VPS en el centro) ============================ //
  const ayuntMesh = buildBuilding(vps.kind);
  ayuntMesh.scale.setScalar(COMPONENT_SCALE);
  ayuntMesh.position.set(0, 0, 0);
  ayuntMesh.userData = { type: "zone", service: vps, client, project, inInterior: true };
  g.add(ayuntMesh);
  interiorZoneMeshes.set(vps.id, ayuntMesh);
  addZoneLabel(ayuntMesh, vps);
  addStatusIcon(ayuntMesh, vps.id, status);

  // Label "ayuntamiento · NombreVPS"
  const plazaDiv = document.createElement("div");
  plazaDiv.className = "barrio-label";
  plazaDiv.textContent = "ayuntamiento · " + vps.name;
  const plazaLbl = new CSS2DObject(plazaDiv);
  plazaLbl.position.set(0, 7, 0);
  g.add(plazaLbl);

  // === SERVICIOS ALOJADOS (calles radiales) ========================= //
  const hosted = services.filter(s => s.config && s.config.on_host === vpsId);
  const N = hosted.length;
  hosted.forEach((svc, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(N, 1);
    const streetGroup = buildStreet(angle, svc.name);

    // Recolor de las piezas de la calle según health
    streetGroup.traverse(obj => {
      if (obj.isMesh && obj.material) {
        // El "asfalto" es la primera mesh dentro del streetGroup
        if (obj.geometry instanceof THREE.BoxGeometry && obj.material.color) {
          obj.material = obj.material.clone();
          obj.material.color.setHex(roadColor);
        }
      }
      if (obj.isLine && obj.material) {
        obj.material = obj.material.clone();
        obj.material.color.setHex(0xffffff);    // líneas blancas siempre (constraste)
      }
    });

    // Edificio al final de la calle
    const mesh = buildBuilding(svc.kind);
    mesh.scale.setScalar(COMPONENT_SCALE);
    const localZ = STREET_RADIUS_START + STREET_LENGTH * 0.7;
    mesh.position.set(0, 0, localZ);
    mesh.userData = { type: "zone", service: svc, client, project, inInterior: true };
    streetGroup.add(mesh);
    addZoneLabel(mesh, svc);
    addStatusIcon(mesh, vps.id, status);

    interiorZoneMeshes.set(svc.id, mesh);
    g.add(streetGroup);
  });

  // === CABLES INTRA-CIUDAD (las connections manuales del .panel.json) ==== //
  const connections = (meta && meta.connections) || [];
  for (const conn of connections) {
    const from = interiorZoneMeshes.get(conn.from);
    const to   = interiorZoneMeshes.get(conn.to);
    if (!from || !to) continue;

    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    from.getWorldPosition(p0);
    to.getWorldPosition(p1);
    p0.y = ZONE_Y * 0.6;
    p1.y = ZONE_Y * 0.6;

    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    mid.y = ZONE_Y * 0.65;
    const curve = new THREE.CatmullRomCurve3([p0, mid, p1]);

    const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.18, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: roadColor });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.userData = { type: "interior-road-asphalt", connection: conn };
    g.add(tube);

    const segments = 48;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const p = curve.getPoint(i / segments);
      p.y += 0.05;
      pts.push(p);
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 0.5, gapSize: 0.5, linewidth: 1,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    line.userData = { type: "interior-road-line", connection: conn };
    g.add(line);
  }

  return g;
};

// Helper: añade un icono CSS2D de estado encima de un mesh.
function addStatusIcon(mesh, vpsId, status) {
  const div = document.createElement("div");
  div.className = "status-icon";
  div.dataset.vpsRef = vpsId;
  div.textContent = STATUS_ICONS[status] || STATUS_ICONS.down;
  const obj = new CSS2DObject(div);
  obj.position.set(0, 5.8, 0);   // ligeramente por encima del label
  mesh.add(obj);
}
```

- [ ] **Step 3: Modificar el botón "Entrar" del side panel de ciudad para pasar `vpsId`**

Localizar `openCityPanel(cityGroup)`. La sección que cablea `spEnterCity`:
```javascript
  sp.querySelector("#spEnterCity").onclick = () => {
    if (typeof enterCity === "function") enterCity(ud.client, ud.project);
  };
```

**Reemplazar** por:
```javascript
  sp.querySelector("#spEnterCity").onclick = () => {
    if (typeof enterCity === "function") enterCity(ud.client, ud.project, ud.vpsId);
  };
```

(Recuerda que `cityGroup.userData` ahora incluye `vpsId` — lo establecimos en `buildVpsCity` Step 4 del Task 3.)

- [ ] **Step 4: Sintaxis check**

Run:
```bash
node --check "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/map3d.js" && echo OK
```

- [ ] **Step 5: Verificación en navegador**

Hard refresh. Esperado:

- [ ] World view muestra ciudades VPS por cliente.
- [ ] Click footprint de una ciudad VPS → side panel con botón "» Entrar en la ciudad".
- [ ] Click "Entrar" → vista interior con la VPS centro + calles radiales hacia cada service hosted (los que tengan `config.on_host = ese-vps-id`).
- [ ] Si la VPS no tiene services con on_host, solo ves el ayuntamiento.
- [ ] Los iconos sobre los edificios son `⛔` por defecto (el healthCache aún no se rellena con polling activo — Task 5).
- [ ] Esc / "← Volver al mundo" vuelve correctamente.

- [ ] **Step 6: Checkpoint** — Interior VPS-centric funciona estructuralmente. Falta polling + actualización visual dinámica.

---

## Task 5: Frontend — Polling health + updateHealthVisuals + healthCache

**Files:**
- Modify: `frontend/map3d.js` (constantes nuevas + funciones de polling + arranque en initMap3D)

- [ ] **Step 1: Añadir constantes y `healthCache`**

Editar `frontend/map3d.js`. Localizar el bloque "Fase 4 — Interior" cerca del final (donde están las constantes `INTERIOR_FRUSTUM`, etc.). **Justo después** de `let mockTicker = null;`, añadir:

```javascript
// Fase 6 — Health polling
const POLL_HEALTH_MS = 30000;
const REGION_PADDING = 4;
const SATELLITE_RADIUS = 8;
const ROAD_COLOR_OK    = 0x5a8ad0;
const ROAD_COLOR_WARN  = 0xf59e0b;
const ROAD_COLOR_DOWN  = 0xef4444;
const STATUS_ICONS     = { ok: "🟢", warn: "⚠️", down: "⛔" };
const healthCache = new Map();   // vpsId → {status, ts, metrics, error}
let healthTimer = null;
let healthFetching = false;
```

- [ ] **Step 2: Implementar `pollHealth`, `startHealthPolling`, `stopHealthPolling`, `updateHealthVisuals`**

**Al final del archivo `map3d.js`** añadir:

```javascript
// Recoge la lista única de (client, project) visibles en el world view (para no
// hacer fetch innecesario por proyectos vacíos).
function visibleProjectsFromCache() {
  const seen = new Set();
  const out = [];
  for (const rec of vpsCityMap.values()) {
    const key = `${rec.client}/${rec.project}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ client: rec.client, project: rec.project });
  }
  return out;
}

async function pollHealth() {
  if (healthFetching) return;
  healthFetching = true;
  try {
    const targets = visibleProjectsFromCache();
    for (const { client, project } of targets) {
      const url = `/api/projects/health?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`;
      const r = await fetch(url);
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
  pollHealth();    // primer fetch inmediato tras arranque
  healthTimer = setInterval(pollHealth, POLL_HEALTH_MS);
}

function stopHealthPolling() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// Recorre la escena actualizando iconos de status y colores de carreteras.
// No reconstruye geometrías; solo modifica materiales y texto de CSS2DObject.
function updateHealthVisuals() {
  // 1. World view: actualiza el icono de status sobre cada VPS city
  for (const [vpsId, rec] of vpsCityMap.entries()) {
    const entry = healthCache.get(vpsId);
    const status = (entry && entry.status) || "down";
    if (rec.statusIcon && rec.statusIcon.element) {
      rec.statusIcon.element.textContent = STATUS_ICONS[status] || STATUS_ICONS.down;
    }
  }

  // 2. Interior view: si estamos dentro de una ciudad, actualiza iconos + colores de calles + cables
  if (interiorGroup && sceneMode.startsWith("interior:")) {
    const vpsIdMatch = sceneMode.match(/^interior:[^/]+\/[^/]+\/(.+)$/);
    if (vpsIdMatch) {
      const vpsId = vpsIdMatch[1];
      const entry = healthCache.get(vpsId);
      const status = (entry && entry.status) || "down";
      const roadColor = status === "warn" ? ROAD_COLOR_WARN
                      : status === "down" ? ROAD_COLOR_DOWN
                      : ROAD_COLOR_OK;
      // Actualiza materiales de carreteras (asfalto)
      interiorGroup.traverse(obj => {
        if (obj.userData && (obj.userData.type === "interior-road-asphalt"
                             || obj.userData.type === "interior-street")) {
          obj.traverse(piece => {
            if (piece.isMesh && piece.material && piece.material.color) {
              if (piece.material.color.getHex() !== 0xffffff) {  // no recolorear líneas blancas
                piece.material.color.setHex(roadColor);
              }
            }
          });
        }
      });
      // Actualiza iconos status sobre cada edificio del interior
      interiorGroup.traverse(obj => {
        if (obj.element && obj.element.classList && obj.element.classList.contains("status-icon")) {
          obj.element.textContent = STATUS_ICONS[status] || STATUS_ICONS.down;
        }
      });
    }
  }

  markDirty();
}
```

- [ ] **Step 3: Arrancar polling en `initMap3D`**

Localizar la función `initMap3D(containerEl)`. **Al final** (después de `loadWorld();`), añadir:

```javascript
  startHealthPolling();
```

- [ ] **Step 4: Sintaxis check**

Run:
```bash
node --check "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/map3d.js" && echo OK
```

- [ ] **Step 5: Verificación end-to-end con polling**

Reiniciar server (esperar 30s para que el backend tenga datos en cache):
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 35  # backend tarda 30s en el primer poll
```

Hard refresh en navegador. Esperado:

- [ ] Tras los 30s iniciales del polling backend + 0-30s del polling frontend, los iconos `⛔` cambian a `🟢` (si SSH funciona) o se quedan `⛔` (si las VPSs no son alcanzables desde el Mac local).
- [ ] Entrar a una VPS → calles azules si VPS ok, rojas si down.
- [ ] Si esperas 30s más, vuelve a actualizar (compruébalo poniendo o quitando alcance a la VPS, p. ej. desconectando wifi un momento).

- [ ] **Step 6: Checkpoint** — Polling activo, iconos y colores responden al estado real del monitor.

---

## Task 6: Frontend — Formulario "Alojado en VPS" selector en modal de servicio

**Files:**
- Modify: `frontend/app.js` (extender `openSvcModal` y `saveSvcFromModal`)

- [ ] **Step 1: Modificar `openSvcModal(id)` en `frontend/app.js`**

Localizar la función `openSvcModal(id)` en `frontend/app.js` (la del modal de servicio del formulario Fase 1). **Tras la línea que establece `$("#svcModalConfig").value = ...`** (justo antes de `$("#svcModalErr").textContent = "";`), añadir:

```javascript
  // Fase 6: selector "Alojado en VPS" visible solo cuando kind != vps
  const onHostLabel = $("#onHostLabel");
  const onHostSelect = $("#svcModalOnHost");
  if (onHostLabel && onHostSelect) {
    const currentKind = $("#svcModalKind").value;
    onHostLabel.classList.toggle("hidden", currentKind === "vps");
    // Poblar opciones con VPSs del proyecto actual (sin la VPS que se está editando)
    onHostSelect.innerHTML = '<option value="">(ninguno — SaaS / no-hostable)</option>';
    for (const s of mapState.services || []) {
      if (s.kind !== "vps") continue;
      if (svc && s.id === svc.id) continue;   // no ofrecerse a sí mismo
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `${s.name} [${s.id}]`;
      onHostSelect.appendChild(opt);
    }
    // Selección inicial: lee del config.on_host si existe
    onHostSelect.value = (svc && svc.config && svc.config.on_host) || "";
  }
  // Listener para que cambiar el kind muestre/oculte el campo
  $("#svcModalKind").onchange = () => {
    if (onHostLabel) onHostLabel.classList.toggle("hidden", $("#svcModalKind").value === "vps");
  };
```

- [ ] **Step 2: Modificar `saveSvcFromModal()` para mergear `on_host`**

Localizar `saveSvcFromModal()` en `frontend/app.js`. Justo **antes** de las dos ramas `if (svcModalEditingId)` / `else { ... mapState.services.push(...) }`, añadir:

```javascript
  // Fase 6: mergear on_host en config (si seleccionado y kind != vps)
  if (kind !== "vps") {
    const onHostVal = $("#svcModalOnHost") ? $("#svcModalOnHost").value : "";
    if (onHostVal) {
      cfg.on_host = onHostVal;
    } else {
      delete cfg.on_host;
    }
  } else {
    // Si es VPS, no tiene sentido on_host; limpiar si quedó del previo
    if (cfg.on_host) delete cfg.on_host;
  }
```

- [ ] **Step 3: Añadir el HTML del selector al modal en `frontend/index.html`**

Localizar el bloque del modal de servicio en `frontend/index.html` (el `<div id="svcModal" class="modal hidden">`). **Localizar el `<label>` que contiene el `<select id="svcModalKind">`** y **justo después de su cierre** (`</label>`), añadir:

```html
      <label id="onHostLabel" class="hidden">Alojado en VPS
        <select id="svcModalOnHost"></select>
      </label>
```

- [ ] **Step 4: Verificación**

Hard refresh. Pestaña Proyectos → entra a un proyecto → sub-pestaña Mapa → "+ Añadir servicio":
- [ ] Si kind = vps: el campo "Alojado en VPS" NO aparece.
- [ ] Si kind = n8n (o cualquier otro): el campo "Alojado en VPS" aparece con un select pre-poblado con las VPSs del proyecto + "(ninguno)".
- [ ] Seleccionar una VPS y guardar → recargar el modal → debería mostrar la VPS seleccionada.
- [ ] El JSON guardado en `.panel.json` debe tener `config.on_host = "vps-XXX"`.
- [ ] Cambiar kind a vps en el modal vuelve a ocultar el campo.

- [ ] **Step 5: Checkpoint** — Selector on_host operativo. El formulario ya rellena la relación de hosting.

---

## Task 7: Frontend — CSS nuevo (region-label, status-icon, satellite-label)

**Files:**
- Modify: `frontend/map3d.css` (añadir al final)

- [ ] **Step 1: Añadir bloque CSS al final de `map3d.css`**

Editar `frontend/map3d.css`. **Al final del archivo** añadir:

```css
/* ============================================================ */
/* Fase 6 — VPS=ciudad + regiones + iconos + satélites           */
/* ============================================================ */

/* Label de región-cliente en world view */
.region-label {
  background: rgba(13, 17, 23, 0.85);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 14px;
  font-size: 13px;
  font-weight: 600;
  pointer-events: none;
  user-select: none;
}

/* Icono emoji de estado sobre cada edificio / ciudad */
.status-icon {
  font-size: 18px;
  filter: drop-shadow(0 0 4px rgba(0,0,0,0.6));
  pointer-events: none;
  user-select: none;
}

/* Label de satélite SaaS orbitando una ciudad */
.satellite-label {
  background: rgba(13, 17, 23, 0.7);
  color: var(--muted);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 10px;
  pointer-events: none;
  user-select: none;
}
```

- [ ] **Step 2: Verificación servida**

Run:
```bash
curl -s http://127.0.0.1:8788/static/map3d.css | grep -E "region-label|status-icon|satellite-label" | head -4
```
Expected: las tres reglas aparecen.

- [ ] **Step 3: Verificación visual**

Hard refresh. Esperado:

- [ ] Cada región-cliente tiene un label estilizado "Cliente: X" arriba.
- [ ] Cada ciudad VPS tiene un emoji (🟢/⚠️/⛔) con drop-shadow.
- [ ] Si declaras `config.satellites_of` en un servicio, su esfera satélite tiene un label pequeño con `[kind] nombre`.

- [ ] **Step 4: Checkpoint** — Estilos aplicados.

---

## Task 8: Verificación end-to-end + commit único final

**Files:** ninguno (verificación) + commit final.

- [ ] **Step 1: Recorrer checklist completa del spec**

Abrir `docs/superpowers/specs/2026-06-30-fase6-vps-ciudad-monitor-vivo-design.md` sección 5 y verificar punto por punto:

**Backend**
- [ ] Server arranca y log muestra `[health-poll] daemon iniciado`.
- [ ] Tras 30s, `GET /api/projects/health?...` devuelve status/metrics para cada VPS.
- [ ] VPS alcanzable → `status: "ok"`. No alcanzable → `status: "down"`.
- [ ] POST meta con `on_host: "vps-INEXISTENTE"` → 400.
- [ ] POST con `satellites_of` referenciando no-VPS → 400.
- [ ] Schema v4: output incluye `version: 4`.

**World view**
- [ ] Agrupado por cliente: cada cliente como región con label.
- [ ] Una ciudad VPS por cada service `kind=vps` (no por proyecto).
- [ ] Icono `🟢/⚠️/⛔` arriba de cada ciudad según health real.
- [ ] Satélites SaaS (si declaras `satellites_of`) aparecen como esferas orbitando.
- [ ] Polling actualiza iconos cada 30s sin recargar.

**Interior**
- [ ] Click footprint VPS → side panel "Entrar".
- [ ] Click "Entrar" → ayuntamiento (VPS) centro + calles radiales a hosted.
- [ ] Calles azules/ámbar/rojas según health del VPS.
- [ ] Iconos `🟢/⚠️/⛔` sobre cada edificio.
- [ ] Side panel ayuntamiento → bloque Estado mostraría datos reales si los hubiera (mientras el mock-aware del side panel no se actualice, sigue mostrando mock; el spec apunta esto como mejora menor — los datos reales están en el endpoint, simplemente no se inyectan al side panel todavía).
- [ ] Esc / "← Volver al mundo" funciona.

**Formulario**
- [ ] Modal de servicio kind=n8n/postgres/etc.: selector "Alojado en VPS" pre-poblado.
- [ ] Modal de servicio kind=vps: selector oculto.
- [ ] Guardar con on_host elegido → persistido en `config.on_host`.

**No regresiones**
- [ ] Pestaña Linear/Monitor/Proyectos siguen idénticas.
- [ ] Sub-pestaña Mapa del formulario Fase 1 sigue funcionando.
- [ ] `.panel.json` v1/v2/v3 cargan sin error.

Si algo falla → vuelve al Task correspondiente, arregla, repite.

- [ ] **Step 2: Apagar server local**

```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
lsof -nP -iTCP:8788 -sTCP:LISTEN 2>&1 || echo "puerto libre"
```

- [ ] **Step 3: Revisar estado de git y stage selectivo**

```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git status --short
git add backend/server.py \
        frontend/map3d.js frontend/map3d.css frontend/app.js frontend/index.html \
        docs/superpowers/plans/2026-06-30-fase6-vps-ciudad-monitor-vivo-plan.md
git status --short
```

Expected: 5 archivos modificados/nuevos staged. NO debe aparecer `backend/panel.conf`.

- [ ] **Step 4: Commit final**

```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git commit -m "$(cat <<'EOF'
feat(fase6): VPS=ciudad + monitorización real en vivo + carreteras dinámicas

Rediseño conceptual del mapa 3D: cada VPS pasa a ser la unidad principal
del mapa (una ciudad por VPS, no por proyecto). World agrupa por cliente
en regiones; cada región contiene las ciudades VPS del cliente. Al entrar
a una ciudad VPS se ve la VPS como ayuntamiento centro + calles radiales
hacia cada servicio alojado (services con config.on_host = vps-id).

- backend/server.py: daemon thread health_poll_loop() cada 30s recorre
  todos los .panel.json, chequea VPSs por SSH (reusa ssh_run +
  build_collector + parse_report ya existentes), y cachea status/metrics
  en HEALTH_CACHE. Nuevo endpoint GET /api/projects/health?client=&project=
  devuelve el cache filtrado por proyecto. Validación cruzada
  on_host/satellites_of en validate_meta_payload (deben referenciar id
  de VPS del mismo proyecto). Schema v4.

- frontend/map3d.js: rewrite completo de buildWorld (agrupa por cliente
  en regiones, una ciudad por VPS) + nuevas funciones buildClientRegion,
  buildVpsCity, buildSatellite. Rewrite de buildInterior con signature
  nueva (client, project, vpsId): filtra services hosted por on_host y los
  coloca al final de calles radiales con color según health (azul/ámbar/
  rojo). Polling frontend cada 30s vía pollHealth() + updateHealthVisuals()
  actualiza iconos y colores sin reconstruir la escena. vpsCityMap (keyed
  por vpsId) reemplaza el viejo cityMap (alias temporal preservado).

- frontend/map3d.css: estilos region-label, status-icon (emoji con drop
  shadow), satellite-label.

- frontend/app.js + frontend/index.html: modal de servicio (formulario
  Fase 1) gana selector "Alojado en VPS" cuando kind != vps; pre-poblado
  con VPSs del proyecto; al guardar merge en config.on_host.

Iconos emoji (🟢/⚠️/⛔) en CSS2D sobre cada edificio reflejan estado real
del VPS host. Carreteras se ven azules si VPS ok, ámbar si warn (>90%
en cpu/ram/disk), rojo si down.

Caveats (a F7+):
- Monitor real solo para VPS. Resto kinds (n8n/docker/postgres/chatwoot/
  github/linear/custom) siguen con mock. Cada uno llega como su fase.
- satellites_of UI: se rellena a mano en config JSON.
- Sin histórico de métricas, sin paralelización del polling.
- Drag-to-rearrange en interior sigue desactivado.

Sin tests automatizados (criterio del proyecto). Verificación manual
con checklist del spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0161kKVTR9U7cMCCVkEvFaDZ
EOF
)"
git log -1 --stat
```

- [ ] **Step 5: Checkpoint final** — Fase 6 completada y commiteada.

---

## Self-review (post-write)

**Spec coverage:**

- Sección 1 del spec (UX/alcance: VPS=ciudad, regiones por cliente, satélites, polling, iconos avería, selector on_host) → Tasks 3 (regiones+ciudades+satélites), 4 (interior VPS-centric), 5 (polling), 6 (selector), 7 (CSS iconos).
- Sección 2 del spec (modelo de datos: on_host, satellites_of, version 4, health cache) → Tasks 1 (validación) y 2 (cache backend).
- Sección 3 del spec (backend polling + endpoint) → Task 2.
- Sección 4 del spec (frontend rewrite + polling) → Tasks 3, 4, 5, 6.
- Sección 5 del spec (verificación + archivos + caveats) → Task 8 ejecuta la checklist.

**Placeholders:** todas las funciones de código completas, sin "TODO" / "TBD" / "fill in details". El comentario "(deprecated)" en `buildCity` y `buildCityCluster` (Task 3 Step 6) es intencional — mantener firmas para no romper imports legacy mientras se reemplaza el modelo.

**Type consistency:**

- `vpsCityMap` (keyed `vpsId` → `{client, project, vps, group, footprint, label, buildingMesh, satellites, statusIcon, projectMeta}`) — consistente entre `buildVpsCity` (Task 3 Step 4), `enterCity` (Task 4 Step 1), `updateHealthVisuals` (Task 5 Step 2), `visibleProjectsFromCache` (Task 5 Step 2).
- `userData.type` valores nuevos: `"client-region"`, `"region-footprint"`, `"satellite"` — usados consistentemente entre `buildClientRegion` y posibles handlers de picking (que no se modifican; raycaster solo pillará `"city-footprint"`, `"zone"`, `"satellite"` — `"satellite"` queda picado pero no hace nada por defecto en F6, side panel no aplica; mejora menor para F7).
- `sceneMode` formato cambia de `"interior:<client>/<project>"` (F4-F5) a `"interior:<client>/<project>/<vpsId>"` (F6). Usado en `enterCity` (set), `exitCity` (lee con `.startsWith("interior:")`), `updateHealthVisuals` (parse con regex), `onKeyDown` y `onMouseDown` (siguen usando `.startsWith("interior:")` así que siguen funcionando).
- `STATUS_ICONS` consistente entre `addStatusIcon` (Task 4 Step 2), `buildVpsCity` (Task 3 Step 4), `updateHealthVisuals` (Task 5 Step 2).
- `ROAD_COLOR_OK|WARN|DOWN` consistente entre `buildInterior` (Task 4) y `updateHealthVisuals` (Task 5).

**Caveats de implementación:**

- El polling backend itera `PROJECTS` directory cada 30s. Si hay muchos clientes/proyectos (>50), un ciclo podría tardar más que 30s (cada VPS lleva hasta `HEALTH_TIMEOUT=15s`). El loop seguirá iterando; aceptable para F6. F7 puede paralelizar.
- `buildCity` y `buildCityCluster` quedan como funciones vacías deprecated en Task 3 Step 6. No se eliminan para no romper algún caller olvidado; F7 puede borrarlas tras `grep` que confirme cero uso.
- En F6, los iconos status sobre los edificios del INTERIOR (n8n, postgres, etc.) reflejan el status del VPS host, no su propio status (porque su monitor real es F7+). Esto puede confundir un poco; el spec lo apunta como caveat.
- El side panel del ayuntamiento (cuando estás en interior) sigue mostrando bloque "Estado simulado" del F4 con mock, no los datos reales del cache. Para inyectar datos reales en el side panel hace falta un cambio en `openZonePanel` que detecte si la zona es la VPS del interior actual y use `healthCache.get(vpsId)` en vez del mock. **NO está en este plan** — queda como mejora menor para F7 (o se puede añadir como Step 4 bis en Task 4 si se quiere meter aquí).
- `addStatusIcon` (helper en Task 4) crea un CSS2DObject anclado al mesh. Esos elementos se limpian correctamente por `disposeGroup` (que ya quita HTMLElements de CSS2DObject desde el fix de F5).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-fase6-vps-ciudad-monitor-vivo-plan.md`. Dos opciones:**

**1. Inline Execution (recomendado)** — Ejecuto las 8 tareas en esta sesión con checkpoints en Tasks 2 (backend), 4 (interior VPS-centric), 5 (polling), 8 (commit final). Toda la implementación cae en 4 archivos modificados; no se paraleliza bien.

**2. Un solo worker que haga las 8 tareas** — Despacho un subagente fresco que ejecuta todo el plan y vuelve con el reporte. Contexto más limpio pero pierdo capacidad de parar a mitad.

**3. Workers en paralelo (backend + frontend)** — Worker A: Tasks 1-2 (backend). Worker B: Tasks 3-7 (frontend, secuenciales). Yo: Task 8 (verif + commit). Más rápido pero el frontend no se paraleliza internamente.

¿Cuál prefieres?
