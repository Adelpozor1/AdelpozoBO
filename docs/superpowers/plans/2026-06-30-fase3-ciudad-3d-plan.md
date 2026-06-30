# Fase 3 — Ciudad 3D — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar la home del panel como un mapa isométrico 3D (Three.js + primitivas) donde cada proyecto del usuario es una ciudad, cada servicio una zona coloreada por kind, y cada conexión un cable; con pan/zoom, Edit Mode (drag persistido), click ciudad → fly-to, click zona → side panel con detalles y placeholder de monitor.

**Architecture:** Frontend vanilla + Three.js 0.160.0 cargado por importmap CDN solo cuando el usuario entra a la nueva pestaña "Mapa" (lazy import). Un módulo dedicado `frontend/map3d.js` mantiene `app.js` sin ensuciar. Backend stdlib añade un solo endpoint `GET /api/world` (evita N+1 fetches) y extiende `validate_meta_payload`/`load_project_meta` de Fase 1 para aceptar y aplicar defaults a `world_position` (por proyecto) y `position` (por servicio), con backwards-compat con `.panel.json` v1.

**Tech Stack:** Python 3 stdlib (backend), HTML5 + CSS3 + JS ESM vanilla (frontend), Three.js 0.160.0 + CSS2DRenderer addon vía importmap (https://unpkg.com).

**Spec de referencia:** `docs/superpowers/specs/2026-06-30-fase3-ciudad-3d-design.md` (commit `ac9189f`).

**Política de commits para esta fase:** **Un único commit al final** (Task 11), igual que Fase 1. Cada task tiene un "Checkpoint" de verificación pero NO commitea.

---

## File structure

**Creados:**

- `frontend/map3d.js` — módulo entero del mapa: bootstrap Three.js, scene/camera/renderer/loop, carga `/api/world`, construye cities/zones/cables, raycaster + hover/click, pan/zoom, Edit Mode + drag manual + persistencia debounced, fly-to, side panels, empty state.
- `frontend/map3d.css` — estilos del contenedor del mapa y overlays (tooltip, side panel, empty state, HUD).
- `docs/superpowers/plans/2026-06-30-fase3-ciudad-3d-plan.md` — este documento.

**Modificados:**

- `backend/server.py` — extender `validate_meta_payload()` con validación de `world_position` y `position`; extender `load_project_meta()` con defaults; nuevo endpoint `GET /api/world`; wirearlo en `do_GET`.
- `frontend/index.html` — `<script type="importmap">`, botón `#tabMap` como primera pestaña, `<div id="map-home">` con overlays (`#mapTooltip`, `#mapSidePanel`, `#mapEmptyState`, `#mapHud`), `<link>` al nuevo CSS.
- `frontend/app.js` — añadir `setSection("map")` al switch existente, lazy `import('/static/map3d.js')` y `initMap3D(...)` la primera vez.

---

## Task 1: Backend — extender metadata helpers + endpoint `GET /api/world`

**Files:**
- Modify: `backend/server.py`

- [ ] **Step 1: Extender `validate_meta_payload()` para aceptar y validar `world_position` + `position`**

Editar `backend/server.py`. Localizar la función `validate_meta_payload()` (añadida en Fase 1, ~ línea 413). Reemplazar la función completa por la siguiente versión, que añade validación de posiciones y emite `version: 2`:

```python
def validate_meta_payload(payload: dict) -> tuple[dict | None, str]:
    """Valida y normaliza un payload entrante para POST /api/projects/meta.
    Devuelve (data_normalizada, "") en éxito o (None, "mensaje de error").
    Asigna ids a servicios/conexiones que no los traen. Detecta colisiones,
    referencias rotas y caps superados. Fase 3: valida world_position por
    proyecto y position por servicio, ambos opcionales."""
    if not isinstance(payload, dict):
        return None, "payload debe ser objeto JSON"
    services = payload.get("services") or []
    connections = payload.get("connections") or []
    if not isinstance(services, list) or not isinstance(connections, list):
        return None, "services y connections deben ser arrays"
    if len(services) > MAX_SERVICES:
        return None, f"máximo {MAX_SERVICES} servicios por proyecto"
    if len(connections) > MAX_CONNECTIONS:
        return None, f"máximo {MAX_CONNECTIONS} conexiones por proyecto"

    # world_position (Fase 3) — opcional, {x, z} finitos en [-10000, 10000]
    wp_in = payload.get("world_position")
    if wp_in is not None:
        if not isinstance(wp_in, dict):
            return None, "world_position debe ser objeto {x, z}"
        wx, wz = wp_in.get("x"), wp_in.get("z")
        if not (isinstance(wx, (int, float)) and isinstance(wz, (int, float))):
            return None, "world_position.x y world_position.z deben ser números"
        if not (-10000 <= wx <= 10000 and -10000 <= wz <= 10000):
            return None, "world_position fuera de rango [-10000, 10000]"
        world_position = {"x": float(wx), "z": float(wz)}
    else:
        world_position = {"x": 0.0, "z": 0.0}

    seen_svc_ids: set[str] = set()
    out_services: list[dict] = []
    for i, s in enumerate(services):
        if not isinstance(s, dict):
            return None, f"servicio {i}: debe ser objeto"
        kind = s.get("kind", "")
        if kind not in SVC_KINDS:
            return None, f"servicio {i}: kind '{kind}' no válido"
        name = s.get("name", "")
        if not isinstance(name, str) or not name.strip():
            return None, f"servicio {i}: name vacío"
        if len(name) > MAX_NAME_LEN:
            return None, f"servicio {i}: name excede {MAX_NAME_LEN} caracteres"
        cfg = s.get("config")
        if cfg is not None and not isinstance(cfg, dict):
            return None, f"servicio {i}: config debe ser objeto o null"
        # position (Fase 3) — opcional
        pos_in = s.get("position")
        if pos_in is not None:
            if not isinstance(pos_in, dict):
                return None, f"servicio {i}: position debe ser objeto {{x, z}}"
            px, pz = pos_in.get("x"), pos_in.get("z")
            if not (isinstance(px, (int, float)) and isinstance(pz, (int, float))):
                return None, f"servicio {i}: position.x y position.z deben ser números"
            if not (-10000 <= px <= 10000 and -10000 <= pz <= 10000):
                return None, f"servicio {i}: position fuera de rango [-10000, 10000]"
            position = {"x": float(px), "z": float(pz)}
        else:
            position = {"x": 0.0, "z": 0.0}
        sid = s.get("id") or _new_id(kind)
        if sid in seen_svc_ids:
            return None, f"servicio {i}: id duplicado '{sid}'"
        seen_svc_ids.add(sid)
        out_services.append({
            "id": sid, "kind": kind, "name": name.strip(),
            "config": cfg if cfg is not None else {},
            "position": position,
        })

    seen_conn_ids: set[str] = set()
    out_connections: list[dict] = []
    for i, ce in enumerate(connections):
        if not isinstance(ce, dict):
            return None, f"conexión {i}: debe ser objeto"
        f, t = ce.get("from", ""), ce.get("to", "")
        if f not in seen_svc_ids:
            return None, f"conexión {i}: from '{f}' no es un servicio del proyecto"
        if t not in seen_svc_ids:
            return None, f"conexión {i}: to '{t}' no es un servicio del proyecto"
        label = ce.get("label", "")
        if not isinstance(label, str):
            return None, f"conexión {i}: label debe ser string"
        if len(label) > MAX_LABEL_LEN:
            return None, f"conexión {i}: label excede {MAX_LABEL_LEN} caracteres"
        cid = ce.get("id") or _new_id("c")
        if cid in seen_conn_ids:
            return None, f"conexión {i}: id duplicado '{cid}'"
        seen_conn_ids.add(cid)
        out_connections.append({"id": cid, "from": f, "to": t, "label": label})

    return {
        "version": 2,
        "world_position": world_position,
        "services": out_services,
        "connections": out_connections,
    }, ""
```

- [ ] **Step 2: Extender `load_project_meta()` con defaults de posición**

Localizar `load_project_meta()` (~ línea 340). Reemplazar la función completa por:

```python
def load_project_meta(c: str, p: str) -> dict:
    """Lee el .panel.json del proyecto. Si no existe → estado vacío. Si está
    corrupto → lanza ValueError. Fase 3: rellena defaults para world_position
    y position por servicio si faltan (backwards-compat con v1)."""
    mp = meta_path(c, p)
    if mp is None or not mp.exists():
        return {
            "version": 2,
            "world_position": {"x": 0.0, "z": 0.0},
            "services": [],
            "connections": [],
        }
    try:
        data = json.loads(mp.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"{PROJECT_META_NAME} corrupto: {e}")
    data.setdefault("version", 1)
    data.setdefault("services", [])
    data.setdefault("connections", [])
    # Fase 3 defaults — backwards-compat con v1
    if "world_position" not in data or not isinstance(data["world_position"], dict):
        data["world_position"] = {"x": 0.0, "z": 0.0}
    for s in data["services"]:
        if isinstance(s, dict) and ("position" not in s or not isinstance(s["position"], dict)):
            s["position"] = {"x": 0.0, "z": 0.0}
    return data
```

- [ ] **Step 3: Añadir handler `_world_get` (endpoint `GET /api/world`)**

Localizar el handler `_proj_meta_get` (añadido en Fase 1). Insertar **inmediatamente después** de ese handler, dentro de la clase `Handler`, el nuevo handler:

```python
    def _world_get(self):
        """Devuelve TODO el mundo (clients → projects → meta) en un solo fetch
        para evitar N+1 desde el frontend. Solo lee del disco; ningún secreto."""
        out_clients = []
        for client_dir in sorted([d for d in PROJECTS.iterdir() if d.is_dir()],
                                 key=lambda d: d.name):
            cname = client_dir.name
            if not valid_name(cname):
                continue
            projs = []
            for proj_dir in sorted([d for d in client_dir.iterdir() if d.is_dir()],
                                   key=lambda d: d.name):
                pname = proj_dir.name
                if not valid_name(pname):
                    continue
                try:
                    with project_lock(f"{cname}/{pname}"):
                        meta = load_project_meta(cname, pname)
                except ValueError as e:
                    # Si un .panel.json está corrupto, lo saltamos y lo logueamos
                    print(f"[world] skip {cname}/{pname}: {e}")
                    continue
                projs.append({
                    "name": pname,
                    "meta": {
                        "version": meta.get("version", 1),
                        "world_position": meta.get("world_position", {"x": 0.0, "z": 0.0}),
                        "services": meta.get("services", []),
                        "connections": meta.get("connections", []),
                    },
                })
            out_clients.append({"name": cname, "projects": projs})
        self._json(200, {"clients": out_clients})
```

- [ ] **Step 4: Wirear `/api/world` en `do_GET`**

Localizar el bloque que ya gestiona `/api/projects/meta` (Fase 1) dentro de `do_GET`. Es el bloque que empieza así:

```python
        elif path in ("/api/clients", "/api/projects", "/api/repos",
                      "/api/repos/branches", "/api/projects/meta"):
```

Reemplazar ese bloque (que ya está modificado por Fase 1) añadiendo `/api/world`:

```python
        elif path in ("/api/clients", "/api/projects", "/api/repos",
                      "/api/repos/branches", "/api/projects/meta", "/api/world"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if path == "/api/clients":
                self._clients()
            elif path == "/api/projects":
                self._projects_of(q.get("client", [""])[0])
            elif path == "/api/repos":
                self._repos_of(q.get("client", [""])[0], q.get("project", [""])[0])
            elif path == "/api/projects/meta":
                self._proj_meta_get(q.get("client", [""])[0], q.get("project", [""])[0])
            elif path == "/api/world":
                self._world_get()
            else:
                self._repo_branches(q.get("client", [""])[0], q.get("project", [""])[0],
                                    q.get("name", [""])[0])
```

- [ ] **Step 5: Arrancar server y smoke test con curl**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
echo "== GET /api/world =="
curl -s -b /tmp/panel-cookie http://127.0.0.1:8788/api/world | python3 -m json.tool | head -60
```

Expected: respuesta con `clients` que incluye `DiveAcademy/Panel` (con world_position {x:0,z:0} y los 2 servicios con position {x:0,z:0}) y `test-client/test-project` (con los servicios del smoke test, también con position {x:0,z:0}).

- [ ] **Step 6: Smoke test de POST con posiciones nuevas**

Run:
```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{
    "client":"DiveAcademy","project":"Panel",
    "world_position":{"x":12,"z":0},
    "services":[
      {"kind":"vps","name":"VPS Hostinger DiveAcademy","config":{"host":"76.13.63.235"},"position":{"x":2.1,"z":-1.8}},
      {"kind":"vps","name":"VPS LAN 192.168.1.29","config":{"host":"192.168.1.29"},"position":{"x":-2.1,"z":1.8}}
    ],
    "connections":[]
  }' | python3 -m json.tool
```
Expected: respuesta `version: 2`, ambos servicios con `position` persistido, world_position {x:12,z:0}.

Validación de rango:
```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"DiveAcademy","project":"Panel","world_position":{"x":99999,"z":0},"services":[],"connections":[]}'
```
Expected: `{"error": "world_position fuera de rango [-10000, 10000]"}`.

Validación de tipo:
```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"DiveAcademy","project":"Panel","world_position":{"x":"hola","z":0},"services":[],"connections":[]}'
```
Expected: `{"error": "world_position.x y world_position.z deben ser números"}`.

- [ ] **Step 7: Checkpoint** — Backend listo. Endpoint `/api/world` operativo. Schema v2 con posiciones validado.

---

## Task 2: Frontend — Scaffolding (importmap + tab + container + CSS)

**Files:**
- Modify: `frontend/index.html`
- Create: `frontend/map3d.css`

- [ ] **Step 1: Añadir importmap de Three.js en el `<head>` de `index.html`**

Editar `frontend/index.html`. Localizar el bloque `<head>...</head>` (al inicio del archivo). **Inmediatamente antes** del `</head>` añadir:

```html
  <script type="importmap">
  {
    "imports": {
      "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
      "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/"
    }
  }
  </script>
  <link rel="stylesheet" href="/static/map3d.css">
```

- [ ] **Step 2: Añadir el botón `#tabMap` como primera pestaña del header**

Editar `frontend/index.html`. Localizar el `<nav id="sections">` (línea aproximada 24-28 tras los cambios de Fase 1). Sustituir su contenido para que `[Mapa]` sea la primera pestaña activa por defecto y las demás pierdan `active`:

```html
  <nav id="sections">
    <button id="tabMap" class="tab active">Mapa</button>
    <button id="tabDev" class="tab">Proyectos</button>
    <button id="tabMon" class="tab">Monitorización</button>
    <button id="tabLinear" class="tab">Linear</button>
  </nav>
```

(Cambios: nueva línea `<button id="tabMap" ...>`; del `<button id="tabDev">` quitar `active`.)

- [ ] **Step 3: Añadir contenedor `#map-home` y overlays antes de `#main-row`**

Editar `frontend/index.html`. Localizar el bloque `<div id="clients-view">` (la primera vista de Proyectos, lo que muestra el grid de clientes). **Inmediatamente antes** de ese `<div id="clients-view">` insertar:

```html
  <!-- HOME: mapa 3D (Fase 3) -->
  <div id="map-home" class="hidden">
    <div id="mapCanvasWrap"></div>
    <div id="mapHud">
      <button id="mapEditToggle" class="hud-btn" title="Bloquea o desbloquea drag">🔒 Layout fijo</button>
      <button id="mapWorldBtn" class="hud-btn hidden" title="Volver al mundo">🌍 Ver mundo</button>
    </div>
    <div id="mapTooltip" class="hidden"></div>
    <div id="mapSidePanel" class="hidden"></div>
    <div id="mapEmptyState" class="hidden">
      <div class="empty-card">
        <h2>Aún no tienes proyectos</h2>
        <p>Crea uno para verlo aquí como ciudad.</p>
        <button id="mapEmptyCreate" class="btn primary">Crear proyecto</button>
      </div>
    </div>
  </div>
```

Y, en el `setSection("dev")` del JS (Task 4), `#clients-view` SOLO se mostrará cuando la sección activa sea "dev" — no toca aquí.

- [ ] **Step 4: Crear `frontend/map3d.css` (estilos base)**

Crear archivo `frontend/map3d.css` con el siguiente contenido:

```css
/* Contenedor del mapa 3D (Fase 3) */
#map-home {
  position: relative;
  width: 100%;
  height: calc(100vh - 64px);    /* alto total menos header */
  overflow: hidden;
  background: #0d1117;
}

#mapCanvasWrap {
  position: absolute;
  inset: 0;
}

#mapCanvasWrap canvas {
  display: block;
}

/* HUD top-right */
#mapHud {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 10;
}

.hud-btn {
  background: rgba(20, 30, 50, 0.85);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  backdrop-filter: blur(4px);
}

.hud-btn:hover { background: rgba(30, 45, 75, 0.95); }
.hud-btn.active { background: #2a4a8a; border-color: #5a8ad0; }

/* Tooltip flotante */
#mapTooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(13, 17, 23, 0.95);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: monospace;
  z-index: 20;
  white-space: nowrap;
}

/* Side panel desde la derecha */
#mapSidePanel {
  position: absolute;
  top: 0;
  right: 0;
  width: 360px;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  overflow-y: auto;
  padding: 16px;
  z-index: 15;
  transform: translateX(0);
  transition: transform 200ms ease-out;
}

#mapSidePanel.hidden {
  transform: translateX(100%);
  display: block;     /* sobreescribimos el .hidden default para animar */
}

.sp-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.sp-breadcrumb {
  font-size: 12px;
  color: var(--muted);
  font-family: monospace;
}

.sp-title {
  font-size: 15px;
  margin: 4px 0;
  color: var(--text);
}

.sp-close {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 18px;
  cursor: pointer;
  padding: 0 6px;
}

.sp-block {
  background: var(--tool);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

.sp-block h4 {
  margin: 0 0 6px 0;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--muted);
  letter-spacing: 0.5px;
}

.sp-config-json {
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--text);
  margin: 0;
}

.sp-placeholder {
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}

.sp-conn-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.sp-conn-list li {
  font-size: 12px;
  color: var(--text);
  padding: 2px 0;
}

.sp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.sp-actions .btn { font-size: 12px; padding: 6px 12px; }

/* CSS2D labels (renderizadas por CSS2DRenderer) */
.city-label {
  background: rgba(13, 17, 23, 0.85);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  font-family: inherit;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

.city-sublabel {
  margin-top: 2px;
  color: var(--muted);
  font-size: 10px;
  font-style: italic;
}

/* Empty state grande (cuando NO hay proyectos en absoluto) */
#mapEmptyState {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}

.empty-card {
  background: rgba(20, 30, 50, 0.92);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 32px;
  text-align: center;
  max-width: 360px;
}

.empty-card h2 { margin: 0 0 8px 0; font-size: 18px; }
.empty-card p { margin: 0 0 16px 0; color: var(--muted); }

/* Check verde efímero tras guardar drag */
.save-pulse {
  position: absolute;
  pointer-events: none;
  color: #22c55e;
  font-size: 14px;
  z-index: 25;
  animation: pulseFade 1s ease-out forwards;
}

@keyframes pulseFade {
  0%   { opacity: 0; transform: translateY(0); }
  20%  { opacity: 1; }
  100% { opacity: 0; transform: translateY(-12px); }
}
```

- [ ] **Step 5: Verificación servida**

Run:
```bash
curl -s http://127.0.0.1:8788/static/index.html | grep -E "tabMap|map-home|map3d.css|importmap" | head -10
curl -s http://127.0.0.1:8788/static/map3d.css | head -5
```
Expected: presencia del importmap, `#tabMap`, `#map-home`, link al CSS; y las primeras líneas del CSS.

- [ ] **Step 6: Checkpoint** — HTML/CSS scaffolding en su sitio. Pestaña Mapa visible en el header pero todavía sin handler (Task 3 lo cablea).

---

## Task 3: Frontend — Bootstrap de Three.js + wire `setSection("map")`

**Files:**
- Create: `frontend/map3d.js`
- Modify: `frontend/app.js`

- [ ] **Step 1: Crear `frontend/map3d.js` con el bootstrap completo (scene/camera/renderer/lights/ground/loop)**

Crear archivo `frontend/map3d.js` con:

```javascript
// frontend/map3d.js — Fase 3: mapa 3D isométrico como home del panel.
// Se carga lazy (dinámicamente) la primera vez que el usuario entra a la
// pestaña "Mapa". Estilos en map3d.css; HTML overlays en index.html (#map-home).

import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

// --- Constantes visuales ---------------------------------------------------
const ZONE_PRIMITIVES = {
  vps:      () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
  n8n:      () => new THREE.CylinderGeometry(0.8, 0.8, 1.5, 16),
  docker:   () => new THREE.BoxGeometry(1.2, 1.2, 1.2),
  chatwoot: () => new THREE.ConeGeometry(0.9, 1.8, 16),
  postgres: () => new THREE.CylinderGeometry(0.9, 0.9, 1.5, 24),
  github:   () => new THREE.OctahedronGeometry(0.9, 0),
  linear:   () => new THREE.TetrahedronGeometry(1.0, 0),
  custom:   () => new THREE.DodecahedronGeometry(0.9, 0),
};

const ZONE_COLORS = {
  vps:      0x8b949e,
  n8n:      0xa371f7,
  docker:   0x2496ed,
  chatwoot: 0xf48120,
  postgres: 0x336791,
  github:   0xe6edf3,
  linear:   0x5e6ad2,
  custom:   0x6e7681,
};

const CITY_FOOTPRINT_SIZE = 10;
const CITY_GRID_SPACING   = 12;
const ZONE_RADIUS         = 3.0;
const ZONE_Y              = 1.0;     // altura desde el footprint
const FRUSTUM_MIN         = 5;
const FRUSTUM_MAX         = 200;
const FRUSTUM_DEFAULT     = 80;
const FLY_TO_FRUSTUM      = 30;
const FLY_TO_MS           = 600;

// --- Estado del módulo (single-instance) ----------------------------------
let scene, camera, renderer, cssRenderer;
let worldGroup;
let container, canvasWrap;
let initialized = false;

// Render dirty-flag
let dirty = true;
function markDirty() { dirty = true; }

// --- API pública ----------------------------------------------------------
export function initMap3D(containerEl) {
  if (initialized) { onResize(); markDirty(); return; }
  container = containerEl;
  canvasWrap = container.querySelector("#mapCanvasWrap");

  // Escena
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  // Cámara ortográfica isométrica
  const aspect = canvasWrap.clientWidth / canvasWrap.clientHeight;
  camera = new THREE.OrthographicCamera(
    -FRUSTUM_DEFAULT * aspect / 2,  FRUSTUM_DEFAULT * aspect / 2,
     FRUSTUM_DEFAULT / 2,          -FRUSTUM_DEFAULT / 2,
     0.1, 1000
  );
  camera.position.set(50, 50, 50);
  camera.lookAt(0, 0, 0);
  camera.userData.frustumSize = FRUSTUM_DEFAULT;

  // Renderer WebGL
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
  canvasWrap.appendChild(renderer.domElement);

  // Renderer CSS2D para etiquetas
  cssRenderer = new CSS2DRenderer();
  cssRenderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
  cssRenderer.domElement.style.position = "absolute";
  cssRenderer.domElement.style.inset = "0";
  cssRenderer.domElement.style.pointerEvents = "none";
  canvasWrap.appendChild(cssRenderer.domElement);

  // Luces
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight.position.set(60, 100, 40);
  scene.add(dirLight);

  // Ground + grid
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: 0x141b27 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.userData.type = "ground";
  scene.add(ground);

  const grid = new THREE.GridHelper(2000, 200, 0x2a3550, 0x1a2030);
  grid.position.y = 0.01;
  scene.add(grid);

  // Grupo de mundo (todas las ciudades cuelgan de aquí)
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  // Render loop (dirty-only)
  function animate() {
    requestAnimationFrame(animate);
    if (dirty) {
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
      dirty = false;
    }
  }
  animate();

  // Resize
  window.addEventListener("resize", onResize);

  initialized = true;
  markDirty();
}

function onResize() {
  if (!canvasWrap) return;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  const aspect = w / h;
  const fs = camera.userData.frustumSize;
  camera.left   = -fs * aspect / 2;
  camera.right  =  fs * aspect / 2;
  camera.top    =  fs / 2;
  camera.bottom = -fs / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  cssRenderer.setSize(w, h);
  markDirty();
}
```

- [ ] **Step 2: Wirear `setSection("map")` en `app.js`**

Editar `frontend/app.js`. Localizar la función `setSection(s)` (línea ~94, ya modificada por Fase 1). Reemplazarla por:

```javascript
function setSection(s) {
  $("#tabMap").classList.toggle("active", s === "map");
  $("#tabDev").classList.toggle("active", s === "dev");
  $("#tabMon").classList.toggle("active", s === "mon");
  $("#tabLinear").classList.toggle("active", s === "linear");
  $("#map-home").classList.toggle("hidden", s !== "map");
  $("#mon-view").classList.toggle("hidden", s !== "mon");
  $("#linear-view").classList.toggle("hidden", s !== "linear");
  const devIds = ["#clients-view", "#projects-view", "#main-row"];
  if (s !== "dev") { monStop(); devIds.forEach(id => $(id).classList.add("hidden")); }
  if (s === "dev") { monStop(); showDev(devScreen); }
  else if (s === "mon") { monEnter(); }
  else if (s === "linear") { linearEnter(); }
  else if (s === "map") { mapEnter(); }
}
```

E **inmediatamente debajo** de los handlers existentes (`$("#tabDev").onclick`, etc.), añadir:

```javascript
$("#tabMap").onclick = () => setSection("map");
```

Y, donde se llama a `setSection("dev")` al loguearse por primera vez (función `showApp` ~ línea 61), reemplazar el `setSection("dev")` por `setSection("map")` para que el home sea el mapa:

Localizar esta línea (aproximada, dentro de `showApp`):
```javascript
  setSection("dev");
```
Cambiarla por:
```javascript
  setSection("map");
```

- [ ] **Step 3: Implementar `mapEnter()` con lazy import en `app.js`**

Editar `frontend/app.js`. **Al final del archivo** añadir:

```javascript
// --------------------------------------------------------------------------- //
// Mapa 3D (Fase 3): lazy import de Three.js solo cuando se abre la pestaña.
// --------------------------------------------------------------------------- //
let map3dApi = null;
async function mapEnter() {
  const host = $("#map-home");
  if (!map3dApi) {
    try {
      const mod = await import("/static/map3d.js");
      map3dApi = mod;
    } catch (e) {
      console.error("No se pudo cargar map3d.js:", e);
      host.innerHTML = '<div style="padding:20px;color:#ef4444">No se pudo cargar el mapa: ' + esc(e.message) + '</div>';
      return;
    }
  }
  map3dApi.initMap3D(host);
}
```

- [ ] **Step 4: Verificación en navegador**

Recargar `http://127.0.0.1:8788`. Esperado:

- [ ] Tras login, la pestaña activa es "Mapa".
- [ ] El área de contenido muestra el `#map-home`: fondo oscuro con un grid 3D isométrico (las líneas del `GridHelper`). Sin ciudades aún (no se cargan datos en Task 3).
- [ ] DevTools → Network: se ve la petición a `unpkg.com/three@0.160.0/...` SOLO al entrar a Mapa la primera vez. Si navegas a otra pestaña y vuelves, no se redescarga.
- [ ] Cambiar a pestaña "Proyectos" → ves el grid normal. Volver a "Mapa" → no se relanza la inicialización (warm).

Console:
```js
$("#tabMap").click();
// Tras un momento (lazy load), debe haber un <canvas> dentro de #mapCanvasWrap
document.querySelectorAll("#mapCanvasWrap canvas").length    // → 1
```

- [ ] **Step 5: Checkpoint** — Three.js arranca, escena vacía visible, lazy import funciona, cambio entre pestañas no rompe estado.

---

## Task 4: Frontend — Cargar `/api/world` y construir cities + zones + cables

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Añadir loader y constructores a `map3d.js`**

Editar `frontend/map3d.js`. **Al final del archivo** (después de `onResize`) añadir:

```javascript
// --- Estado de datos ------------------------------------------------------
const cityMap = new Map();   // key "client/project" → { group, footprint, label, zones: Map<id, mesh>, cables: Map<id, line>, projectMeta }
let worldLoaded = false;

export async function loadWorld() {
  try {
    const r = await fetch("/api/world");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    buildWorld(data);
    worldLoaded = true;
    markDirty();
    return data;
  } catch (e) {
    console.error("loadWorld:", e);
    return null;
  }
}

function clearWorld() {
  for (const c of cityMap.values()) {
    worldGroup.remove(c.group);
    disposeGroup(c.group);
  }
  cityMap.clear();
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

function buildWorld(data) {
  clearWorld();
  const all = [];
  for (const cli of data.clients || []) {
    for (const proj of cli.projects || []) {
      all.push({ client: cli.name, project: proj.name, meta: proj.meta || {} });
    }
  }
  // Auto-layout: indices secuenciales en un grid sqrt(N)x sqrt(N) para los
  // proyectos sin world_position propia.
  const cols = Math.max(1, Math.ceil(Math.sqrt(all.length)));
  let autoIndex = 0;
  for (const entry of all) {
    const wp = entry.meta.world_position || autoLayoutCity(autoIndex, cols);
    autoIndex++;
    const cityGroup = buildCity(entry.client, entry.project, entry.meta, wp);
    worldGroup.add(cityGroup);
  }
}

function autoLayoutCity(index, cols) {
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    x: (col - (cols - 1) / 2) * CITY_GRID_SPACING,
    z: (row - 0) * CITY_GRID_SPACING,
  };
}

function autoLayoutZone(index, total) {
  const t = Math.max(total, 3);
  const angle = (2 * Math.PI * index) / t;
  return {
    x: ZONE_RADIUS * Math.cos(angle),
    z: ZONE_RADIUS * Math.sin(angle),
  };
}

function buildCity(client, project, meta, worldPos) {
  const group = new THREE.Group();
  group.userData = { type: "city", client, project, meta };
  group.position.set(worldPos.x, 0, worldPos.z);

  // Footprint
  const footprint = new THREE.Mesh(
    new THREE.BoxGeometry(CITY_FOOTPRINT_SIZE, 0.15, CITY_FOOTPRINT_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x202a3a })
  );
  footprint.position.y = 0.08;
  footprint.userData = { type: "city-footprint", client, project };
  group.add(footprint);

  // Label CSS2D
  const labelDiv = document.createElement("div");
  labelDiv.className = "city-label";
  labelDiv.textContent = `${client} / ${project}`;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, 2.5, 0);
  group.add(label);

  const services = meta.services || [];
  // Sub-label "ciudad sin zonas" si el proyecto está vacío
  if (services.length === 0) {
    const subDiv = document.createElement("div");
    subDiv.className = "city-sublabel";
    subDiv.textContent = "ciudad sin zonas";
    labelDiv.appendChild(subDiv);
  }

  // Zones
  const zoneMap = new Map();
  services.forEach((svc, idx) => {
    const pos = svc.position && (svc.position.x || svc.position.z)
      ? svc.position
      : autoLayoutZone(idx, services.length);
    const zone = buildZone(svc, pos, client, project);
    zoneMap.set(svc.id, zone);
    group.add(zone);
  });

  // Cables
  const cableMap = new Map();
  for (const conn of meta.connections || []) {
    const a = zoneMap.get(conn.from);
    const b = zoneMap.get(conn.to);
    if (!a || !b) continue;
    const cable = buildCable(conn, a, b);
    cableMap.set(conn.id, cable);
    group.add(cable);
  }

  cityMap.set(`${client}/${project}`, {
    group, footprint, label, zones: zoneMap, cables: cableMap, projectMeta: meta,
  });
  return group;
}

function buildZone(svc, pos, client, project) {
  const geo = (ZONE_PRIMITIVES[svc.kind] || ZONE_PRIMITIVES.custom)();
  const mat = new THREE.MeshStandardMaterial({ color: ZONE_COLORS[svc.kind] || ZONE_COLORS.custom });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { type: "zone", service: svc, client, project };
  mesh.position.set(pos.x, ZONE_Y, pos.z);
  return mesh;
}

function buildCable(conn, fromMesh, toMesh) {
  const points = cablePoints(fromMesh.position, toMesh.position);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x5a8ad0, linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  line.userData = { type: "cable", connection: conn, fromId: conn.from, toId: conn.to };
  return line;
}

function cablePoints(p0, p1) {
  // Línea recta a ras de zona (Y ligeramente por debajo de ZONE_Y para no atravesar mesh)
  const y = ZONE_Y * 0.8;
  return [
    new THREE.Vector3(p0.x, y, p0.z),
    new THREE.Vector3(p1.x, y, p1.z),
  ];
}
```

- [ ] **Step 2: Llamar a `loadWorld()` desde `initMap3D`**

En el mismo archivo `map3d.js`, modificar el final de `initMap3D` (justo antes del `markDirty()` final) para llamar a `loadWorld()`:

Sustituir esta línea final de `initMap3D`:
```javascript
  initialized = true;
  markDirty();
}
```
por:
```javascript
  initialized = true;
  markDirty();
  loadWorld();        // primer fetch del mundo
}
```

- [ ] **Step 3: Verificación en navegador**

Recargar `http://127.0.0.1:8788`. Esperado:

- [ ] Tras login + pestaña Mapa: aparecen 2 ciudades en el grid (DiveAcademy/Panel y test-client/test-project).
- [ ] Cada ciudad tiene su label CSS2D flotante encima.
- [ ] Dentro de cada ciudad, sus servicios aparecen como primitivas coloreadas:
  - VPS = box gris (DiveAcademy tiene 2)
  - n8n = cilindro morado
  - ...
- [ ] Si hay conexiones, aparecen líneas azules entre zonas. (Si no creaste conexiones en el sandbox, no se verán.)
- [ ] DevTools → Network: `GET /api/world` llamado una sola vez en la carga.

Console rápido:
```js
// Cantidad de ciudades renderizadas
document.querySelectorAll(".city-label").length   // ≥ 2
```

- [ ] **Step 4: Checkpoint** — Mundo se carga y se pinta. Ciudades, zonas y cables aparecen. Sin interactividad aún (solo visual estático).

---

## Task 5: Frontend — Pan + zoom + zoom limits + raycaster base

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Añadir variables y handlers de input al final del módulo**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// --- Input: pan + zoom + raycaster ----------------------------------------
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
let lastHover = null;       // último objeto bajo el ratón (zone/city-footprint/cable)

let isPanning = false;
let panStart = null;        // {camX, camZ, mouseX, mouseY}

function ndcFromEvent(ev) {
  const rect = canvasWrap.getBoundingClientRect();
  mouseNDC.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
  mouseNDC.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1;
}

function raycast() {
  raycaster.setFromCamera(mouseNDC, camera);
  // recursive=true para entrar en cityGroups y pillar zones/footprints/cables
  return raycaster.intersectObject(worldGroup, true);
}

function pickInteractive(hits) {
  // Devuelve el primer hit que tiene userData.type interesante
  for (const h of hits) {
    let obj = h.object;
    while (obj) {
      const t = obj.userData && obj.userData.type;
      if (t === "zone" || t === "city-footprint" || t === "cable") return obj;
      obj = obj.parent;
    }
  }
  return null;
}

function onMouseDown(ev) {
  if (ev.button !== 0) return;
  ndcFromEvent(ev);
  // Pan: solo si NO clickas sobre nada interactivo
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked) {
    // No-op aquí; Task 6 lo extiende para drag en Edit Mode.
    return;
  }
  isPanning = true;
  panStart = { camX: camera.position.x, camZ: camera.position.z, mx: ev.clientX, my: ev.clientY };
}

function onMouseMove(ev) {
  ndcFromEvent(ev);
  if (isPanning && panStart) {
    // pan: convertir delta de pixels en delta de mundo según frustumSize
    const fs = camera.userData.frustumSize;
    const rect = canvasWrap.getBoundingClientRect();
    const worldPerPxX = fs * (rect.width / rect.height) / rect.width;
    const worldPerPxY = fs / rect.height;
    const dx = (ev.clientX - panStart.mx) * worldPerPxX;
    const dy = (ev.clientY - panStart.my) * worldPerPxY;
    // Como la cámara mira con yaw=45°, traducimos a coords mundo
    camera.position.x = panStart.camX - dx * Math.cos(Math.PI / 4) - dy * Math.sin(Math.PI / 4);
    camera.position.z = panStart.camZ + dx * Math.sin(Math.PI / 4) - dy * Math.cos(Math.PI / 4);
    markDirty();
    return;
  }
  // Hover (sin drag): raycaster
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked !== lastHover) {
    lastHover = picked;
    onHoverChange(picked, ev);     // Task 6 implementa tooltip
  } else if (picked) {
    onHoverMove(ev);                // Task 6 actualiza posición del tooltip
  }
}

function onMouseUp(ev) {
  if (ev.button !== 0) return;
  isPanning = false;
  panStart = null;
}

function onWheel(ev) {
  ev.preventDefault();
  // zoom centrado en el cursor
  const fs = camera.userData.frustumSize;
  const factor = ev.deltaY > 0 ? 1.1 : 1 / 1.1;
  const newFs = Math.max(FRUSTUM_MIN, Math.min(FRUSTUM_MAX, fs * factor));
  if (newFs === fs) return;

  // Punto del mundo bajo el cursor antes del zoom
  ndcFromEvent(ev);
  const beforePoint = unprojectToGround(mouseNDC, camera);

  // Aplicar zoom
  setFrustum(newFs);

  // Punto del mundo bajo el cursor después
  const afterPoint = unprojectToGround(mouseNDC, camera);

  // Ajustar la cámara para que el punto bajo el cursor no se mueva
  camera.position.x += beforePoint.x - afterPoint.x;
  camera.position.z += beforePoint.z - afterPoint.z;
  markDirty();
}

function setFrustum(fs) {
  camera.userData.frustumSize = fs;
  const aspect = canvasWrap.clientWidth / canvasWrap.clientHeight;
  camera.left   = -fs * aspect / 2;
  camera.right  =  fs * aspect / 2;
  camera.top    =  fs / 2;
  camera.bottom = -fs / 2;
  camera.updateProjectionMatrix();
}

function unprojectToGround(ndc, cam) {
  // Devuelve el punto en Y=0 al que apunta este NDC
  const v = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(cam);
  const dir = new THREE.Vector3().subVectors(v, cam.position).normalize();
  // Si la cámara es ortográfica, el ray empieza en v y va en dir = lookAt direction
  const origin = cam.isOrthographicCamera ? v.clone() : cam.position.clone();
  const t = -origin.y / dir.y;
  return new THREE.Vector3(origin.x + t * dir.x, 0, origin.z + t * dir.z);
}

// Stubs para Task 6 (tooltip)
function onHoverChange(obj, ev) {/* Task 6 */}
function onHoverMove(ev) {/* Task 6 */}

function bindInput() {
  const el = canvasWrap;
  el.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  el.addEventListener("wheel", onWheel, { passive: false });
}
```

- [ ] **Step 2: Llamar a `bindInput()` desde `initMap3D`**

En `initMap3D`, justo antes del `loadWorld()` final, añadir:
```javascript
  bindInput();
```

Posición final de `initMap3D`:
```javascript
  initialized = true;
  markDirty();
  bindInput();
  loadWorld();
}
```

- [ ] **Step 3: Verificación en navegador**

Recargar. Esperado:

- [ ] Drag con click izquierdo sobre el suelo → pan funciona.
- [ ] Wheel scroll → zoom in/out con suavidad, centrado en el cursor.
- [ ] Zoom demasiado in/out → se queda clavado en el extremo (no rebota más allá).
- [ ] Click sobre una zona o ciudad → NO panea (raycaster lo detecta como objeto interactivo; Edit Mode/click llegan en tasks siguientes).

- [ ] **Step 4: Checkpoint** — Navegación básica (pan + zoom) operativa.

---

## Task 6: Frontend — Hover tooltip

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Sustituir los stubs `onHoverChange` y `onHoverMove` por la implementación real**

Editar `frontend/map3d.js`. **Reemplazar** los stubs:

```javascript
// Stubs para Task 6 (tooltip)
function onHoverChange(obj, ev) {/* Task 6 */}
function onHoverMove(ev) {/* Task 6 */}
```

por:

```javascript
let tooltipEl = null;
let tooltipTimer = null;

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = container.querySelector("#mapTooltip");
  return tooltipEl;
}

function tooltipFor(obj) {
  if (!obj) return "";
  const ud = obj.userData || {};
  if (ud.type === "zone") {
    const s = ud.service || {};
    return `${s.kind || "?"} · ${s.name || ""}`;
  }
  if (ud.type === "city-footprint") {
    return `${ud.client} / ${ud.project}`;
  }
  if (ud.type === "cable") {
    const c = ud.connection || {};
    return c.label || "";
  }
  return "";
}

function onHoverChange(obj, ev) {
  ensureTooltip();
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  const text = tooltipFor(obj);
  if (!text) {
    tooltipEl.classList.add("hidden");
    canvasWrap.style.cursor = "default";
    return;
  }
  // delay 200ms antes de mostrar
  tooltipTimer = setTimeout(() => {
    tooltipEl.textContent = text;
    tooltipEl.classList.remove("hidden");
    positionTooltip(ev);
  }, 200);
  // cursor según tipo
  if (obj.userData.type === "zone" || obj.userData.type === "city-footprint") {
    canvasWrap.style.cursor = "pointer";
  } else {
    canvasWrap.style.cursor = "default";
  }
}

function onHoverMove(ev) {
  if (!tooltipEl || tooltipEl.classList.contains("hidden")) return;
  positionTooltip(ev);
}

function positionTooltip(ev) {
  const rect = container.getBoundingClientRect();
  tooltipEl.style.left = (ev.clientX - rect.left + 12) + "px";
  tooltipEl.style.top  = (ev.clientY - rect.top  + 12) + "px";
}
```

- [ ] **Step 2: Verificación en navegador**

Recargar. Esperado:

- [ ] Pasar el ratón sobre una zona → tras 200ms aparece tooltip "kind · nombre".
- [ ] Mover el ratón sigue al cursor.
- [ ] Sacar el ratón fuera de la zona → tooltip desaparece.
- [ ] Hover sobre footprint de ciudad (entre zonas) → tooltip con nombre del proyecto.
- [ ] Hover sobre cable → tooltip con su `label` (si existe).
- [ ] Cursor cambia a "pointer" sobre objetos interactivos; "default" sobre el suelo.

- [ ] **Step 3: Checkpoint** — Hover tooltip operativo.

---

## Task 7: Frontend — Edit Mode + drag de cities/zones + persistencia

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Añadir estado de Edit Mode y handlers de drag**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// --- Edit Mode + drag manual ---------------------------------------------
let editMode = false;
let draggingObj = null;       // mesh siendo arrastrada (zone o cityFootprint)
let dragStart = null;         // { x0, z0, pickedAt:{x,z}, clientPath }
let dragMoved = false;

function setEditMode(on) {
  editMode = !!on;
  const btn = container.querySelector("#mapEditToggle");
  if (btn) {
    btn.textContent = editMode ? "✏️ Modo edición" : "🔒 Layout fijo";
    btn.classList.toggle("active", editMode);
  }
}

function bindHud() {
  const btn = container.querySelector("#mapEditToggle");
  if (btn) btn.onclick = () => setEditMode(!editMode);
}

// Extender onMouseDown para drag de objetos en Edit Mode.
const _onMouseDown_orig = onMouseDown;
onMouseDown = function(ev) {
  if (ev.button !== 0) return;
  ndcFromEvent(ev);
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked && editMode && (picked.userData.type === "zone" || picked.userData.type === "city-footprint")) {
    // start drag
    const ground = unprojectToGround(mouseNDC, camera);
    if (picked.userData.type === "zone") {
      draggingObj = picked;
      dragStart = { x0: picked.position.x, z0: picked.position.z, pickedAt: ground };
    } else {
      // city-footprint: arrastramos el cityGroup entero
      draggingObj = picked.parent;     // el cityGroup
      dragStart = { x0: draggingObj.position.x, z0: draggingObj.position.z, pickedAt: ground };
    }
    dragMoved = false;
    return;
  }
  if (picked) return;   // click sobre algo interactivo SIN Edit Mode → ignora (click handlers en Task 8)
  // Pan fallback
  isPanning = true;
  panStart = { camX: camera.position.x, camZ: camera.position.z, mx: ev.clientX, my: ev.clientY };
};

// Extender onMouseMove para mover el objeto arrastrado
const _onMouseMove_orig = onMouseMove;
onMouseMove = function(ev) {
  ndcFromEvent(ev);
  if (draggingObj && dragStart) {
    const ground = unprojectToGround(mouseNDC, camera);
    const dx = ground.x - dragStart.pickedAt.x;
    const dz = ground.z - dragStart.pickedAt.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.05) dragMoved = true;
    if (draggingObj.userData.type === "zone") {
      draggingObj.position.x = dragStart.x0 + dx;
      draggingObj.position.z = dragStart.z0 + dz;
      // Actualizar cables que tocan esta zona
      updateCablesForZone(draggingObj);
    } else {
      // cityGroup
      draggingObj.position.x = dragStart.x0 + dx;
      draggingObj.position.z = dragStart.z0 + dz;
    }
    markDirty();
    return;
  }
  // Pan
  if (isPanning && panStart) {
    const fs = camera.userData.frustumSize;
    const rect = canvasWrap.getBoundingClientRect();
    const worldPerPxX = fs * (rect.width / rect.height) / rect.width;
    const worldPerPxY = fs / rect.height;
    const dx2 = (ev.clientX - panStart.mx) * worldPerPxX;
    const dy2 = (ev.clientY - panStart.my) * worldPerPxY;
    camera.position.x = panStart.camX - dx2 * Math.cos(Math.PI / 4) - dy2 * Math.sin(Math.PI / 4);
    camera.position.z = panStart.camZ + dx2 * Math.sin(Math.PI / 4) - dy2 * Math.cos(Math.PI / 4);
    markDirty();
    return;
  }
  // Hover (sin drag/pan): raycaster
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked !== lastHover) {
    lastHover = picked;
    onHoverChange(picked, ev);
  } else if (picked) {
    onHoverMove(ev);
  }
};

// Extender onMouseUp para confirmar drag y persistir
const _onMouseUp_orig = onMouseUp;
onMouseUp = function(ev) {
  if (ev.button !== 0) return;
  if (draggingObj && dragMoved) {
    persistDragged(draggingObj);
    showSavePulse(ev);
  }
  draggingObj = null;
  dragStart = null;
  dragMoved = false;
  isPanning = false;
  panStart = null;
};

function updateCablesForZone(zoneMesh) {
  const cityGroup = zoneMesh.parent;
  cityGroup.traverse(obj => {
    if (!obj.userData || obj.userData.type !== "cable") return;
    const fromId = obj.userData.fromId;
    const toId = obj.userData.toId;
    const cityKey = cityKeyOf(cityGroup);
    const cityRec = cityMap.get(cityKey);
    if (!cityRec) return;
    const a = cityRec.zones.get(fromId);
    const b = cityRec.zones.get(toId);
    if (!a || !b) return;
    const points = cablePoints(a.position, b.position);
    obj.geometry.setFromPoints(points);
    obj.geometry.attributes.position.needsUpdate = true;
  });
}

function cityKeyOf(cityGroup) {
  const ud = cityGroup.userData || {};
  return `${ud.client}/${ud.project}`;
}

const _persistTimers = new Map();
function persistDragged(obj) {
  // Determina qué proyecto y dispara POST debounced 300ms
  let cityGroup;
  if (obj.userData.type === "zone") {
    cityGroup = obj.parent;
  } else {
    cityGroup = obj;   // ya es el cityGroup
  }
  const key = cityKeyOf(cityGroup);
  const cityRec = cityMap.get(key);
  if (!cityRec) return;
  // Actualizar el meta en memoria con las posiciones actuales
  const meta = cityRec.projectMeta;
  meta.world_position = { x: cityGroup.position.x, z: cityGroup.position.z };
  for (const svc of meta.services || []) {
    const m = cityRec.zones.get(svc.id);
    if (m) svc.position = { x: m.position.x, z: m.position.z };
  }
  // Debounce
  if (_persistTimers.has(key)) clearTimeout(_persistTimers.get(key));
  _persistTimers.set(key, setTimeout(() => doPersist(cityGroup.userData.client, cityGroup.userData.project, meta), 300));
}

async function doPersist(client, project, meta) {
  try {
    const r = await fetch("/api/projects/meta", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client, project,
        world_position: meta.world_position,
        services: meta.services,
        connections: meta.connections,
      }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    const data = await r.json();
    // Actualizar ids (deberían ser los mismos) y posiciones desde la respuesta
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) {
      rec.projectMeta.services = data.services || rec.projectMeta.services;
      rec.projectMeta.connections = data.connections || rec.projectMeta.connections;
      rec.projectMeta.world_position = data.world_position || rec.projectMeta.world_position;
    }
  } catch (e) {
    alert("No se pudo guardar la posición: " + e.message);
  }
}

function showSavePulse(ev) {
  const rect = container.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "save-pulse";
  el.textContent = "✓ guardado";
  el.style.left = (ev.clientX - rect.left + 10) + "px";
  el.style.top  = (ev.clientY - rect.top  - 10) + "px";
  container.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}
```

- [ ] **Step 2: Wirear los handlers nuevos (sustituir los listeners en `bindInput`)**

En `bindInput()`, los listeners hacen referencia a las funciones por nombre. Como reasignamos `onMouseDown` etc. con `let`, JS resuelve la versión nueva al evaluar la closure. Sin embargo, dado el patrón con `const _xxx_orig`, mejor refactorizar `bindInput` para no depender del orden. **Reemplazar** `bindInput()` por:

```javascript
function bindInput() {
  const el = canvasWrap;
  el.addEventListener("mousedown", (e) => onMouseDown(e));
  window.addEventListener("mousemove", (e) => onMouseMove(e));
  window.addEventListener("mouseup", (e) => onMouseUp(e));
  el.addEventListener("wheel", (e) => onWheel(e), { passive: false });
  bindHud();
}
```

(Wrapping en arrow functions diferidas asegura que las versiones reasignadas se invocan en runtime.)

NB: las declaraciones originales `function onMouseDown(ev)` deben cambiarse a `let onMouseDown = function(ev) { ... }`. Aplicar el mismo cambio a `onMouseMove` y `onMouseUp` (las versiones del Task 5). Reemplazar las firmas `function X(ev) {}` por `let X = function(ev) {}` para esos tres handlers. (Esto permite reasignación posterior sin warnings.)

- [ ] **Step 3: Verificación en navegador**

Recargar. Esperado:

- [ ] Botón HUD "🔒 Layout fijo" visible. Click → cambia a "✏️ Modo edición" + activa estilo.
- [ ] Con Edit Mode OFF: drag sobre zona/footprint = nada (pan no se inicia tampoco porque hay objeto debajo; queda sin efecto — esto es comportamiento deseado).
- [ ] Con Edit Mode ON: drag sobre una zona → la zona sigue al cursor; cables que la tocan se actualizan en vivo.
- [ ] Soltar drag → check verde "✓ guardado" aparece y se desvanece.
- [ ] Recargar página → la zona aparece en la posición nueva.
- [ ] Drag sobre footprint de ciudad (entre las zonas) → mueve la ciudad entera; al soltar persiste.
- [ ] Drag pequeño (<0.05 unidades) NO dispara persist (umbral evita ruido).

Verificación adicional con curl tras un drag:
```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=DiveAcademy&project=Panel" | python3 -m json.tool | head -25
```
Expected: `world_position` y `position` por servicio reflejan los movimientos.

- [ ] **Step 4: Checkpoint** — Edit Mode + drag + persistencia debounced operativos.

---

## Task 8: Frontend — Click ciudad → fly-to + click zona/ciudad → side panel

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Añadir distinción click vs drag + manejadores de click**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// --- Click handlers + fly-to ----------------------------------------------
let mouseDownAt = null;   // {x, y} para distinguir click de drag
const CLICK_THRESHOLD_PX = 5;

// Re-extender onMouseDown para registrar el punto inicial
const _onMouseDown_v3 = onMouseDown;
onMouseDown = function(ev) {
  if (ev.button === 0) mouseDownAt = { x: ev.clientX, y: ev.clientY };
  _onMouseDown_v3(ev);
};

// Re-extender onMouseUp: si NO se movió >5px y el destino del mousedown era un objeto interactivo, es un click
const _onMouseUp_v3 = onMouseUp;
onMouseUp = function(ev) {
  if (ev.button === 0 && mouseDownAt) {
    const dist = Math.hypot(ev.clientX - mouseDownAt.x, ev.clientY - mouseDownAt.y);
    if (dist < CLICK_THRESHOLD_PX) {
      // Click puro (sin drag): raycast y dispatcha
      ndcFromEvent(ev);
      const hits = raycast();
      const picked = pickInteractive(hits);
      if (picked) handleClick(picked, ev);
      else handleGroundClick(ev);
    }
  }
  mouseDownAt = null;
  _onMouseUp_v3(ev);
};

function handleClick(obj, ev) {
  const t = obj.userData.type;
  if (t === "zone") {
    openZonePanel(obj);
  } else if (t === "city-footprint") {
    // Si el side panel está cerrado: fly-to. Si está abierto: cierra primero.
    if (!sidePanelOpen) flyToCity(obj.parent);
    openCityPanel(obj.parent);
  }
}

function handleGroundClick(ev) {
  // Click en suelo → cierra side panel
  closeSidePanel();
}

// Animación fly-to (centra la cámara sobre una ciudad)
let flyAnim = null;
function flyToCity(cityGroup) {
  cancelFly();
  const targetX = cityGroup.position.x;
  const targetZ = cityGroup.position.z;
  // Cámara isométrica: ajustamos camera.position.x/z manteniendo la altura
  const startX = camera.position.x, startZ = camera.position.z;
  const startFs = camera.userData.frustumSize;
  const endFs = FLY_TO_FRUSTUM;
  // Posición destino de la cámara (para que mire al centro de la ciudad)
  const offsetX = 50, offsetZ = 50;   // mismo offset que el initial setup
  const endX = targetX + offsetX, endZ = targetZ + offsetZ;
  const t0 = performance.now();
  flyAnim = function step(now) {
    const t = Math.min(1, (now - t0) / FLY_TO_MS);
    const k = easeInOut(t);
    camera.position.x = startX + (endX - startX) * k;
    camera.position.z = startZ + (endZ - startZ) * k;
    setFrustum(startFs + (endFs - startFs) * k);
    markDirty();
    if (t < 1) flyAnim = requestAnimationFrame(step);
    else flyAnim = null;
  };
  flyAnim = requestAnimationFrame(flyAnim);
  // Mostrar botón "Ver mundo"
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.classList.remove("hidden");
}

function flyToWorld() {
  cancelFly();
  const startX = camera.position.x, startZ = camera.position.z;
  const startFs = camera.userData.frustumSize;
  const endFs = FRUSTUM_DEFAULT;
  const endX = 50, endZ = 50;
  const t0 = performance.now();
  flyAnim = function step(now) {
    const t = Math.min(1, (now - t0) / FLY_TO_MS);
    const k = easeInOut(t);
    camera.position.x = startX + (endX - startX) * k;
    camera.position.z = startZ + (endZ - startZ) * k;
    setFrustum(startFs + (endFs - startFs) * k);
    markDirty();
    if (t < 1) flyAnim = requestAnimationFrame(step);
    else flyAnim = null;
  };
  flyAnim = requestAnimationFrame(flyAnim);
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.classList.add("hidden");
}

function cancelFly() {
  if (flyAnim && typeof flyAnim === "number") cancelAnimationFrame(flyAnim);
  flyAnim = null;
}

function easeInOut(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }

// Stubs para Task 9 (side panel)
let sidePanelOpen = false;
function openZonePanel(zoneMesh) { /* Task 9 */ }
function openCityPanel(cityGroup) { /* Task 9 */ }
function closeSidePanel() { /* Task 9 */ }

// HUD: botón "Ver mundo"
function bindWorldBtn() {
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.onclick = () => flyToWorld();
}
```

- [ ] **Step 2: Llamar a `bindWorldBtn()` desde `initMap3D`**

En `initMap3D`, justo después de `bindInput()`, añadir:
```javascript
  bindWorldBtn();
```

- [ ] **Step 3: Verificación en navegador**

Recargar. Esperado:

- [ ] Click sobre el footprint de una ciudad → cámara hace fly-to animado durante ~600ms, centrando esa ciudad y haciendo zoom in.
- [ ] Botón "🌍 Ver mundo" en HUD aparece cuando estás zoom-in.
- [ ] Click "Ver mundo" → cámara vuelve al mundo entero, botón se oculta.
- [ ] Click en una zona → console log (todavía no abre side panel; lo abre Task 9).
- [ ] Drag (mover ratón >5px antes de soltar) NO se trata como click.

- [ ] **Step 4: Checkpoint** — Click vs drag distinguido; fly-to operativo; botón Ver mundo funciona.

---

## Task 9: Frontend — Side panels (zona + ciudad) + Esc

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Sustituir los stubs por la implementación real de los side panels**

Editar `frontend/map3d.js`. **Reemplazar** los stubs del Task 8:

```javascript
let sidePanelOpen = false;
function openZonePanel(zoneMesh) { /* Task 9 */ }
function openCityPanel(cityGroup) { /* Task 9 */ }
function closeSidePanel() { /* Task 9 */ }
```

por:

```javascript
let sidePanelOpen = false;
let sidePanelContext = null;     // { type: "zone" | "city", ... }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function openZonePanel(zoneMesh) {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  const svc = zoneMesh.userData.service;
  const client = zoneMesh.userData.client;
  const project = zoneMesh.userData.project;
  const meta = (cityMap.get(`${client}/${project}`) || {}).projectMeta || {};
  const connections = (meta.connections || []).filter(c => c.from === svc.id || c.to === svc.id);
  const nameOf = id => {
    const m = (meta.services || []).find(x => x.id === id);
    return m ? m.name : id;
  };
  sp.innerHTML = `
    <div class="sp-header">
      <div>
        <div class="sp-breadcrumb">${escapeHtml(client)} / ${escapeHtml(project)}</div>
        <div class="sp-title">${escapeHtml(svc.name)}</div>
        <div class="svc-kind-badge">${escapeHtml(svc.kind)}</div>
      </div>
      <button class="sp-close" id="spCloseBtn">×</button>
    </div>
    <div class="sp-block">
      <h4>Config</h4>
      <pre class="sp-config-json">${escapeHtml(JSON.stringify(svc.config || {}, null, 2))}</pre>
    </div>
    <div class="sp-block">
      <h4>Estado</h4>
      <div class="sp-placeholder">Monitor en vivo: disponible en Fase 2</div>
    </div>
    <div class="sp-block">
      <h4>Conexiones (${connections.length})</h4>
      ${connections.length ? `<ul class="sp-conn-list">${connections.map(c => {
        const dir = c.from === svc.id ? "→" : "←";
        const other = c.from === svc.id ? c.to : c.from;
        const lbl = c.label ? ` (${escapeHtml(c.label)})` : "";
        return `<li>este ${dir} ${escapeHtml(nameOf(other))}${lbl}</li>`;
      }).join("")}</ul>` : '<div class="sp-placeholder">Sin conexiones</div>'}
    </div>
    <div class="sp-actions">
      <button class="btn" id="spOpenForm">Editar en formulario</button>
      <button class="btn danger" id="spDeleteZone">Borrar zona</button>
    </div>`;
  sp.classList.remove("hidden");
  sidePanelOpen = true;
  sidePanelContext = { type: "zone", client, project, serviceId: svc.id };
  // Handlers
  sp.querySelector("#spCloseBtn").onclick = closeSidePanel;
  sp.querySelector("#spOpenForm").onclick = () => openServiceInForm(client, project, svc.id);
  sp.querySelector("#spDeleteZone").onclick = () => deleteZoneFromPanel(client, project, svc.id);
}

function openCityPanel(cityGroup) {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  const ud = cityGroup.userData;
  const meta = ud.meta || {};
  const nServices = (meta.services || []).length;
  const nConns = (meta.connections || []).length;
  sp.innerHTML = `
    <div class="sp-header">
      <div>
        <div class="sp-breadcrumb">${escapeHtml(ud.client)}</div>
        <div class="sp-title">${escapeHtml(ud.project)}</div>
      </div>
      <button class="sp-close" id="spCloseBtn">×</button>
    </div>
    <div class="sp-block">
      <h4>Contenido</h4>
      <div>${nServices} zona(s) · ${nConns} conexión(es)</div>
    </div>
    <div class="sp-actions">
      <button class="btn" id="spOpenCity">Abrir editor</button>
      <button class="btn" id="spRenameCity">Renombrar proyecto</button>
      <button class="btn danger" id="spDeleteCity">Borrar proyecto</button>
    </div>`;
  sp.classList.remove("hidden");
  sidePanelOpen = true;
  sidePanelContext = { type: "city", client: ud.client, project: ud.project };
  sp.querySelector("#spCloseBtn").onclick = closeSidePanel;
  sp.querySelector("#spOpenCity").onclick = () => openProjectMapForm(ud.client, ud.project);
  sp.querySelector("#spRenameCity").onclick = () => renameProjectFromPanel(ud.client, ud.project);
  sp.querySelector("#spDeleteCity").onclick = () => deleteProjectFromPanel(ud.client, ud.project);
}

function closeSidePanel() {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  sp.classList.add("hidden");
  sidePanelOpen = false;
  sidePanelContext = null;
}

// --- Acciones del side panel ---------------------------------------------
function openServiceInForm(client, project, serviceId) {
  // Cambia a la pestaña "Proyectos" → entra al proyecto → sub-pestaña Mapa (Fase 1)
  // Reusa las funciones globales existentes de app.js.
  closeSidePanel();
  if (typeof window.openClient !== "function" || typeof window.openProject !== "function") {
    // Fallback: cambia de sección, el usuario hace click manual
    setSectionGlobal("dev");
    return;
  }
  setSectionGlobal("dev");
  window.openClient(client).then(() => window.openProject(project)).then(() => {
    if (typeof window.projTabSet === "function") window.projTabSet("map");
    // Highlight: scroll-into-view de la fila del servicio si existe
    setTimeout(() => {
      const row = document.querySelector(`[data-svc-id="${serviceId}"]`);
      if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.style.outline = "2px solid #5a8ad0"; setTimeout(() => row.style.outline = "", 1500); }
    }, 300);
  });
}

function openProjectMapForm(client, project) {
  closeSidePanel();
  if (typeof window.openClient !== "function" || typeof window.openProject !== "function") {
    setSectionGlobal("dev"); return;
  }
  setSectionGlobal("dev");
  window.openClient(client).then(() => window.openProject(project)).then(() => {
    if (typeof window.projTabSet === "function") window.projTabSet("map");
  });
}

function setSectionGlobal(s) {
  // setSection vive en app.js (global). Lo invocamos vía window.
  if (typeof window.setSection === "function") window.setSection(s);
}

async function deleteZoneFromPanel(client, project, serviceId) {
  if (!confirm("¿Borrar esta zona? También se borrarán sus conexiones.")) return;
  const rec = cityMap.get(`${client}/${project}`);
  if (!rec) return;
  const meta = rec.projectMeta;
  meta.services = (meta.services || []).filter(s => s.id !== serviceId);
  meta.connections = (meta.connections || []).filter(c => c.from !== serviceId && c.to !== serviceId);
  await doPersist(client, project, meta);
  // Reconstruye solo esa ciudad
  rebuildCity(client, project);
  closeSidePanel();
  markDirty();
}

async function renameProjectFromPanel(client, project) {
  const nn = (prompt("Nuevo nombre del proyecto:", project) || "").trim();
  if (!nn || nn === project) return;
  try {
    const r = await fetch("/api/projects/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, name: project, new_name: nn }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    closeSidePanel();
    await loadWorld();
  } catch (e) { alert("No se pudo renombrar: " + e.message); }
}

async function deleteProjectFromPanel(client, project) {
  if (!confirm(`¿Borrar el proyecto "${project}" y todo lo que contiene?`)) return;
  try {
    const r = await fetch("/api/projects/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, name: project }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    closeSidePanel();
    await loadWorld();
  } catch (e) { alert("No se pudo borrar: " + e.message); }
}

function rebuildCity(client, project) {
  const key = `${client}/${project}`;
  const rec = cityMap.get(key);
  if (!rec) return;
  worldGroup.remove(rec.group);
  disposeGroup(rec.group);
  cityMap.delete(key);
  const wp = rec.projectMeta.world_position || { x: 0, z: 0 };
  const newGroup = buildCity(client, project, rec.projectMeta, wp);
  worldGroup.add(newGroup);
}
```

- [ ] **Step 2: Esc key para cerrar panel + cancelar drag + zoom-out**

En `frontend/map3d.js`, **al final del archivo** añadir:

```javascript
function onKeyDown(ev) {
  if (ev.key !== "Escape") return;
  // Cancelar drag en curso: revertir
  if (draggingObj && dragStart) {
    if (draggingObj.userData.type === "zone") {
      draggingObj.position.x = dragStart.x0;
      draggingObj.position.z = dragStart.z0;
      updateCablesForZone(draggingObj);
    } else {
      draggingObj.position.x = dragStart.x0;
      draggingObj.position.z = dragStart.z0;
    }
    draggingObj = null;
    dragStart = null;
    dragMoved = false;
    markDirty();
    return;
  }
  // Si hay side panel abierto, cerrarlo
  if (sidePanelOpen) { closeSidePanel(); return; }
  // Si Edit Mode activo, desactivar
  if (editMode) { setEditMode(false); return; }
  // Si no estamos en vista mundo, fly-to-world
  if (camera.userData.frustumSize !== FRUSTUM_DEFAULT) { flyToWorld(); return; }
}

window.addEventListener("keydown", onKeyDown);
```

- [ ] **Step 3: Verificación en navegador**

Recargar. Esperado:

- [ ] Click sobre una zona → side panel slide-in desde la derecha con todo el contenido.
- [ ] "Editar en formulario" → cambia a pestaña Proyectos, entra a ese cliente/proyecto, abre sub-pestaña Mapa (Fase 1), destaca brevemente la fila del servicio.
- [ ] "Borrar zona" → confirmación → zona desaparece + conexiones huérfanas también + side panel cerrado.
- [ ] Click sobre el footprint de una ciudad → side panel reducido con contador + 3 botones.
- [ ] "Abrir editor" → navega al formulario de Fase 1 del proyecto.
- [ ] "Renombrar" / "Borrar proyecto" → funcionan; tras la acción, el mundo se recarga.
- [ ] Esc cierra el panel; otro Esc desactiva Edit Mode; otro Esc hace fly-to-world.
- [ ] Esc durante un drag → la pieza vuelve a su posición de inicio, no se persiste.

- [ ] **Step 4: Checkpoint** — Side panels y Esc cierra/cancela operativos.

---

## Task 10: Frontend — Empty state + sincronización con cambios externos

**Files:**
- Modify: `frontend/map3d.js`, `frontend/app.js`

- [ ] **Step 1: Mostrar `#mapEmptyState` cuando el mundo está vacío**

Editar `frontend/map3d.js`. Localizar la función `buildWorld(data)` (Task 4) y, **al final** (después del bucle de ciudades), añadir:

```javascript
  // Empty state
  const empty = (data.clients || []).every(c => (c.projects || []).length === 0);
  const overlay = container.querySelector("#mapEmptyState");
  if (overlay) overlay.classList.toggle("hidden", !empty);
}
```

(Sustituir el cierre actual `}` del `buildWorld` por el bloque anterior.)

- [ ] **Step 2: Wirear el botón "Crear proyecto" del empty state**

Editar `frontend/map3d.js`. En `initMap3D`, justo después de `bindWorldBtn();`, añadir:

```javascript
  const ec = container.querySelector("#mapEmptyCreate");
  if (ec) ec.onclick = () => {
    if (typeof window.setSection === "function") window.setSection("dev");
  };
```

- [ ] **Step 3: Reload del mundo cuando se hacen cambios en Proyectos**

Editar `frontend/app.js`. Localizar las funciones `loadClients()`, `loadProjects()`, y los handlers de "+ Nuevo cliente"/"+ Nuevo proyecto"/"borrar"/"renombrar". Tras cada éxito, si `map3dApi` existe, refrescar el mundo.

Patrón a aplicar: en cada función `async function delClient(name) { ... if (r.ok) loadClients(); ... }`, añadir `if (map3dApi && map3dApi.loadWorld) map3dApi.loadWorld();` tras el `if (r.ok)`.

Concretamente, **encontrar y modificar** estos puntos (los selectores son por nombre de función o handler):

```javascript
// 1) Crear cliente:
$("#newClientBtn").onclick = async () => {
  // ... código existente ...
  if (r.ok) {
    loadClients();
    if (map3dApi && map3dApi.loadWorld) map3dApi.loadWorld();   // NEW
  }
  // ...
};

// 2) delClient(name):
async function delClient(name) {
  // ... código existente ...
  if (r.ok) {
    loadClients();
    if (map3dApi && map3dApi.loadWorld) map3dApi.loadWorld();   // NEW
  }
  // ...
}

// 3) renameClient(name): igual patrón, tras loadClients().
// 4) "+ Nuevo proyecto" handler: tras loadProjects(), añadir el refresh.
// 5) delProject(name): tras loadProjects(), añadir refresh.
// 6) renameProject(name): tras loadProjects(), añadir refresh.
```

Aplicar el `if (map3dApi && map3dApi.loadWorld) map3dApi.loadWorld();` después de **cada** `loadClients()` o `loadProjects()` que ocurra en respuesta a una mutación (no en lecturas).

- [ ] **Step 4: Verificación**

Recargar. Esperado:

- [ ] En el sandbox actual hay proyectos, así que el empty state NO debe aparecer.
- [ ] Borrar todos los proyectos manualmente con curl o desde la pestaña Proyectos, recargar → empty state aparece. Click "Crear proyecto" → cambia a pestaña Proyectos.
- [ ] Crear un proyecto desde Proyectos → al volver a Mapa, la nueva ciudad ya aparece (sin recargar la página).

```bash
# Limpiar sandbox para forzar empty state:
rm -rf "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects"/*
# Recargar navegador. Empty state debe aparecer.
```

- [ ] **Step 5: Checkpoint** — Empty state visible cuando corresponde; sincronización con Proyectos funciona.

---

## Task 11: Verificación end-to-end con la checklist del spec + commit único

**Files:** ninguno (verificación) + commit final.

- [ ] **Step 1: Recorrer la checklist completa del spec**

Abrir `docs/superpowers/specs/2026-06-30-fase3-ciudad-3d-design.md` sección 5 y verificar punto por punto:

**Boot y carga inicial**
- [ ] Tras login, pestaña activa por defecto = "Mapa".
- [ ] Sin proyectos → empty state grande + botón "Crear proyecto".
- [ ] Con proyectos → ciudades en grid auto.
- [ ] Three.js cargado solo al primer setSection("map") (Network tab).
- [ ] `GET /api/world` se llama una sola vez en la carga inicial.

**Navegación**
- [ ] Wheel → zoom centrado en cursor.
- [ ] Drag en suelo → pan.
- [ ] Wheel demasiado → clamp `frustumSize ∈ [5, 200]`.
- [ ] Click en ciudad → fly-to 600ms.
- [ ] Esc → cierra panel, sale Edit Mode, zoom-out al mundo.

**Edit Mode**
- [ ] Default OFF: drag en ciudad/zona = nada/pan.
- [ ] Toggle ON: cursor "move"; drag mueve.
- [ ] Al soltar, check ✓ verde + persistido. Recarga → posición persistida.
- [ ] Coords fuera de rango → backend 400 (verificar con curl manual).

**Side panel zona**
- [ ] Click zona → slide-in.
- [ ] Muestra: badge, nombre, JSON config, placeholder monitor, conexiones.
- [ ] "Editar en formulario" → navega a sub-pestaña Mapa de Fase 1.
- [ ] "Borrar zona" → desaparece + conexiones huérfanas limpiadas + side panel cerrado.
- [ ] Click en suelo o Esc → cierra side panel.

**Side panel ciudad**
- [ ] Click footprint → side panel reducido.
- [ ] Renombrar/borrar → mundo se recarga.

**Tooltip**
- [ ] Hover 200ms → tooltip aparece.
- [ ] Mover ratón fuera → tooltip oculto.

**Datos**
- [ ] `.panel.json` v1 (sin posiciones) carga + auto-asigna sin error.
- [ ] Tras drag, recarga → posición persistida con `version: 2`.
- [ ] `GET /api/world` NO incluye `linear.token` ni secretos.

**Compatibilidad**
- [ ] Pestaña Proyectos: idéntica.
- [ ] Sub-pestaña Mapa de Fase 1: idéntica.
- [ ] Pestaña Linear: idéntica.
- [ ] Pestaña Monitorización: idéntica.

Si algún punto falla → vuelve al Task correspondiente, arregla, repite.

- [ ] **Step 2: Apagar server local**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
lsof -nP -iTCP:8788 -sTCP:LISTEN 2>&1 || echo "puerto libre"
```

- [ ] **Step 3: Revisar estado de git**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git status --short
```

Expected: deben aparecer modificados `backend/server.py`, `frontend/index.html`, `frontend/app.js`; y como nuevos `frontend/map3d.js`, `frontend/map3d.css`, `docs/superpowers/plans/2026-06-30-fase3-ciudad-3d-plan.md`.

NO debe aparecer `backend/panel.conf` (gitignored) ni nada del sandbox `projects_dir`.

- [ ] **Step 4: Stage selectivo**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && \
git add backend/server.py \
        frontend/index.html frontend/app.js \
        frontend/map3d.js frontend/map3d.css \
        docs/superpowers/plans/2026-06-30-fase3-ciudad-3d-plan.md
git status --short
```

Expected: 6 archivos en staged, nada extra.

- [ ] **Step 5: Commit con HEREDOC**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git commit -m "$(cat <<'EOF'
feat(fase3): ciudad 3D como home del panel (Three.js isométrico)

- frontend: nueva pestaña "Mapa" (primera del header, activa por defecto)
  como home del panel. Three.js 0.160 via importmap CDN, lazy-loaded solo
  al entrar a la pestaña. map3d.js dedicado (no contamina app.js).
  Una ciudad por proyecto, una zona por servicio (primitiva 3D coloreada
  por kind), cables como líneas entre zonas. Cámara ortográfica isométrica
  con pan/zoom continuo. Hover tooltip, click ciudad = fly-to animado
  600ms, click zona = side panel slide-in desde la derecha con config,
  placeholder de monitor (Fase 2), conexiones y acciones (editar / borrar).
  Side panel para ciudad con renombrar / borrar proyecto. Edit Mode con
  drag de ciudades/zonas; posiciones persistidas debounced. Empty state
  cuando no hay proyectos. Esc cierra panel / sale de Edit Mode / cancela
  drag / zoom-out al mundo.
- backend: nuevo endpoint GET /api/world (evita N+1 fetches). Schema
  .panel.json extiende a version 2 con world_position (por proyecto) y
  position (por servicio) opcionales; backwards-compat con v1 (defaults
  aplicados en load_project_meta). validate_meta_payload valida rangos.
- docs: plan en docs/superpowers/plans/.

Sigue sin tests automatizados (igual que Fase 1; criterio del proyecto).
Verificación manual con la checklist del spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0161kKVTR9U7cMCCVkEvFaDZ
EOF
)"
git log -1 --stat
```

- [ ] **Step 6: Checkpoint final** — Fase 3 completada y commiteada.

---

## Self-review (post-write)

**Spec coverage:** cada sección del spec tiene tarea.

- Sección 1 (UX/alcance: pestaña Mapa, convive con Proyectos, pan/zoom/drag, click zona = side panel, empty state) → Tasks 2, 3, 5, 6, 7, 8, 9, 10.
- Sección 2 (modelo de datos: version 2, world_position, position, defaults, backwards-compat) → Task 1.
- Sección 3 (arquitectura: Three.js + CSS2D, lazy import, scene structure, render dirty, raycaster, drag manual, fly-to, performance) → Tasks 3, 4, 5, 6, 7, 8.
- Sección 4 (interacciones detalladas: side panels, tooltip, Edit Mode HUD, pan/zoom límites, fly-to, empty state, Esc) → Tasks 5, 6, 7, 8, 9, 10.
- Sección 5 (verificación, archivos, caveats) → Task 11 ejecuta la checklist; archivos enumerados en File structure.

**Placeholders:** los stubs `function openZonePanel(...) { /* Task 9 */ }` etc. son contratos cruzados explícitos que se sustituyen por la implementación real en su Task correspondiente. No son placeholders sino documentación de orden. Todo el resto del código está completo.

**Type consistency:**

- `cityMap` (`Map` de key `"client/project"` → record) — usado consistentemente en Tasks 4, 7, 9 (rebuildCity, updateCablesForZone, deleteZoneFromPanel).
- `cityRec` = `{ group, footprint, label, zones: Map<id, mesh>, cables: Map<id, line>, projectMeta }` — la propiedad `projectMeta` se accede igual desde drag (Task 7) y desde side panels (Task 9).
- `userData.type` valores: `"city"`, `"city-footprint"`, `"zone"`, `"cable"`, `"ground"` — usados consistentemente en `pickInteractive`, `handleClick`, `tooltipFor`, `updateCablesForZone`.
- `FRUSTUM_DEFAULT`, `FRUSTUM_MIN`, `FRUSTUM_MAX`, `FLY_TO_FRUSTUM` — constantes coherentes entre `setFrustum`, `onWheel`, `flyToCity`, `flyToWorld`, `onKeyDown`.
- `_persistTimers` (Map) — usado solo en `persistDragged`.

**Caveats de implementación**:

- La técnica de `let onMouseDown = function(ev) { ... }` + reasignación posterior depende del orden de carga del módulo. Si JS evalúa secuencialmente (que sí), `onMouseDown` apunta a la última versión cuando se invoca por el listener (que está envuelto en arrow function diferida). Verificado en Task 7.
- Los selectores `window.openClient`, `window.openProject`, `window.projTabSet`, `window.setSection` asumen que esas funciones de `app.js` están en el ámbito global. Lo están (declarations a nivel top en app.js).
- `data-svc-id` referenciado en `openServiceInForm` (highlight de la fila del servicio editado) NO existe en el HTML actual del formulario de Fase 1. Para que el highlight funcione, en una Task post-3 se podría añadir ese atributo a las filas de servicio del formulario. Si no se añade, el `scroll-into-view` no destacará nada — pero el resto del flujo (navegar a pestaña/proyecto/sub-pestaña Mapa) funcionará. Aceptable como degradación silenciosa.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-fase3-ciudad-3d-plan.md`. Dos opciones de ejecución:**

**1. Subagent-Driven** — Despacho un subagente fresco por tarea con review entre tareas. Pro: contexto limpio. Contra: cada subagente vuelve a leer ficheros (más tokens).

**2. Inline Execution (recomendado para este plan)** — Ejecuto las 11 tareas en esta misma sesión con checkpoints. Hay dependencias secuenciales fuertes (Task 5 extiende mousedown del Task 4; Task 7 extiende del Task 5/6; Task 8 extiende del Task 7) que se manejan mejor con contexto continuo.

¿Cuál prefieres? También sigue disponible "varios workers en paralelo" si quieres separar backend (Task 1) del frontend (Tasks 2-10), pero las dependencias internas del frontend hacen que ese sub-plan tenga que ser serial.
