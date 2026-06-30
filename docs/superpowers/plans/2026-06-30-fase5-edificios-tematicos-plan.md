# Fase 5 — Edificios temáticos + star topology + mini-ciudades — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar las primitivas individuales del mapa 3D por edificios temáticos compuestos de primitivas Three.js. World view: cada ciudad se renderiza como cluster compacto (ayuntamiento central + hasta 4 secundarios + badge "+N más"). Interior: topología en estrella con plaza central (ayuntamiento = primer VPS + VPSs/dockers alrededor) + calles radiales por cada barrio no-infra, edificios alineados a ambos lados de su calle.

**Architecture:** Toda la implementación cae en `frontend/map3d.js` (~+400 líneas) extendiendo el módulo existente. Las recetas de edificios viven en una constante declarativa `BUILDING_RECIPES` interpretada por un loop genérico (`buildBuilding(kind)`); añadir/modificar un edificio = ~5-10 líneas de datos. Schema `.panel.json` bumpea a `version: 3` con un campo opcional `interior_position` por servicio (preparado para drag-to-rearrange en F6, no usado en F5). Backend mínimo (~10 líneas en `validate_meta_payload` + `load_project_meta`).

**Tech Stack:** JavaScript ES modules vanilla, Three.js 0.160.0 self-hosted en `frontend/vendor/` (sin cambios), HTML5 + CSS3. Backend Python stdlib (`backend/server.py`).

**Spec de referencia:** `docs/superpowers/specs/2026-06-30-fase5-edificios-tematicos-design.md` (commit `71a6557`).

**Política de commits:** **Un único commit al final** (Task 6). Cada task tiene "Checkpoint" de verificación pero NO commitea.

---

## File structure

**Modificados:**

- `backend/server.py` (~+10 líneas: `validate_meta_payload` valida `interior_position`; `load_project_meta` rellena defaults; output `version: 3`).
- `frontend/map3d.js` (~+400 líneas: `BUILDING_RECIPES`, `buildGeo`, `buildBuilding`, `buildCityCluster`, `firstVps`, `buildStreet`, `addZoneLabel`; reescritura completa de `buildInterior` con star topology; modificación de `buildCity` para usar `buildCityCluster`).
- `frontend/map3d.css` (~+15 líneas: `.street-label`, `.cluster-more-badge`).

**Sin tocar:** `backend/panel.conf` (config local), `.gitignore`, `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`, `frontend/vendor/*` (Three.js sin cambios).

**Creados:** `docs/superpowers/plans/2026-06-30-fase5-edificios-tematicos-plan.md` (este documento).

---

## Task 1: Backend — Schema v3 (interior_position)

**Files:**
- Modify: `backend/server.py`

- [ ] **Step 1: Extender `validate_meta_payload` para validar `interior_position`**

Localizar `validate_meta_payload()` en `backend/server.py` (la versión actual ya valida `world_position` y `position` desde F3/F4). Dentro del loop que itera servicios (`for i, s in enumerate(services)`), después del bloque que valida `position`, añadir el bloque equivalente para `interior_position`:

```python
        # interior_position (Fase 5) — opcional, {x, z} en rango más acotado [-50, 50]
        ipos_in = s.get("interior_position")
        if ipos_in is not None:
            if not isinstance(ipos_in, dict):
                return None, f"servicio {i}: interior_position debe ser objeto {{x, z}}"
            ipx, ipz = ipos_in.get("x"), ipos_in.get("z")
            if not (isinstance(ipx, (int, float)) and isinstance(ipz, (int, float))):
                return None, f"servicio {i}: interior_position.x y interior_position.z deben ser números"
            if not (-50 <= ipx <= 50 and -50 <= ipz <= 50):
                return None, f"servicio {i}: interior_position fuera de rango [-50, 50]"
            interior_position = {"x": float(ipx), "z": float(ipz)}
        else:
            interior_position = {"x": 0.0, "z": 0.0}
```

En el `out_services.append({...})` de ese mismo loop, añadir la nueva clave `interior_position`:

```python
        out_services.append({
            "id": sid, "kind": kind, "name": name.strip(),
            "config": cfg if cfg is not None else {},
            "position": position,
            "interior_position": interior_position,
        })
```

Y al final de la función, en el `return {...}`, **bumpear** `version: 2` → `version: 3`:

```python
    return {
        "version": 3,
        "world_position": world_position,
        "services": out_services,
        "connections": out_connections,
    }, ""
```

- [ ] **Step 2: Extender `load_project_meta` para rellenar defaults**

Localizar `load_project_meta()` (alrededor de la línea 340). El bloque actual hace `data.setdefault("services", [])` y un loop que añade `position` por defecto. Modificar ese loop para añadir también `interior_position` si falta:

```python
    # Fase 3/5 defaults — backwards-compat con v1/v2
    if "world_position" not in data or not isinstance(data["world_position"], dict):
        data["world_position"] = {"x": 0.0, "z": 0.0}
    for s in data["services"]:
        if not isinstance(s, dict):
            continue
        if "position" not in s or not isinstance(s["position"], dict):
            s["position"] = {"x": 0.0, "z": 0.0}
        if "interior_position" not in s or not isinstance(s["interior_position"], dict):
            s["interior_position"] = {"x": 0.0, "z": 0.0}
    return data
```

- [ ] **Step 3: Reiniciar server y verificar con curl**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
echo "== GET /api/world incluye interior_position =="
curl -s -b /tmp/panel-cookie http://127.0.0.1:8788/api/world | python3 -m json.tool | grep -A1 "interior_position" | head -20
echo "== POST meta con interior_position válido =="
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"DiveAcademy","project":"Panel","services":[
    {"kind":"vps","name":"VPS Hostinger DiveAcademy","config":{"host":"76.13.63.235"},"position":{"x":2.1,"z":-1.8},"interior_position":{"x":5,"z":3}},
    {"kind":"vps","name":"VPS LAN 192.168.1.29","config":{"host":"192.168.1.29"},"position":{"x":-2.1,"z":1.8}}
  ],"connections":[]}' | python3 -m json.tool | grep -E "version|interior_position" | head -10
echo "== Validación: interior_position fuera de rango =="
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"DiveAcademy","project":"Panel","services":[{"kind":"vps","name":"x","interior_position":{"x":99,"z":0}}],"connections":[]}'
```

Expected:
- `GET /api/world` muestra `interior_position: {x:0, z:0}` para todos los servicios (defaults aplicados).
- POST happy path devuelve `version: 3` y servicios con `interior_position` persistido (5,3) para el primero, default (0,0) para el segundo.
- Validación fuera de rango → `{"error": "servicio 0: interior_position fuera de rango [-50, 50]"}`.

- [ ] **Step 4: Checkpoint** — Backend listo. Schema v3 acepta y persiste `interior_position`.

---

## Task 2: map3d.js — BUILDING_RECIPES + buildGeo + buildBuilding

**Files:**
- Modify: `frontend/map3d.js`

- [ ] **Step 1: Añadir constantes y helpers al final de `map3d.js`**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// ============================================================ //
// Fase 5 — Edificios temáticos + star topology + mini-ciudades  //
// ============================================================ //

// Constantes de layout
const STREET_LENGTH        = 8;        // longitud de cada calle radial
const STREET_RADIUS_START  = 6;        // donde empieza la calle (fuera de la plaza)
const STREET_WIDTH         = 1.2;
const PLAZA_RADIUS         = 3.5;      // radio para VPSs/dockers adicionales alrededor del ayuntamiento
const CITY_CLUSTER_CENTRAL_SCALE   = 0.5;
const CITY_CLUSTER_SECONDARY_SCALE = 0.4;
const CITY_CLUSTER_MAX     = 5;        // edificios visibles en world cluster

// Recetas de edificios (composición declarativa de primitivas Three.js)
// Cada pieza: {geo: [type, ...args], color: hex, y, x?, z?, rotY?}
const BUILDING_RECIPES = {
  vps: [
    { geo: ["box", 3, 1.5, 3],          color: 0x8b949e, y: 0.75 },              // base
    { geo: ["cone", 2.2, 0.8, 4],       color: 0x5c6470, y: 1.9 },               // tejado dos aguas
    { geo: ["cyl", 0.6, 0.6, 1.5, 12],  color: 0xa1a8b3, y: 2.75 },              // torre
    { geo: ["spheredome", 0.7, 12, 6],  color: 0xd4a017, y: 3.5 },               // cúpula dorada
  ],
  n8n: [
    { geo: ["box", 1.5, 4, 1.5],        color: 0xa371f7, y: 2 },                 // torre
    { geo: ["box", 1.6, 0.1, 1.6],      color: 0x5e3eb5, y: 4.05 },              // tejado plano
    { geo: ["box", 0.05, 3.5, 0.05],    color: 0xe6d4ff, y: 2, x: 0.76 },        // franja ventanas +X
    { geo: ["box", 0.05, 3.5, 0.05],    color: 0xe6d4ff, y: 2, x: -0.76 },       // franja ventanas -X
    { geo: ["box", 0.05, 3.5, 0.05],    color: 0xe6d4ff, y: 2, z: 0.76 },        // franja ventanas +Z
  ],
  docker: [
    { geo: ["box", 3, 1, 2],            color: 0x2496ed, y: 0.5 },               // base almacén
    { geo: ["box", 0.6, 0.6, 0.6],      color: 0xff5733, y: 1.3, x: -0.8 },      // contenedor rojo
    { geo: ["box", 0.6, 0.6, 0.6],      color: 0xffc300, y: 1.3, x: 0 },         // contenedor amarillo
    { geo: ["box", 0.6, 0.6, 0.6],      color: 0x2196f3, y: 1.9, x: -0.4 },      // contenedor azul (encima)
  ],
  chatwoot: [
    { geo: ["cyl", 0.5, 0.7, 3, 12],    color: 0xf48120, y: 1.5 },               // torre cónica
    { geo: ["cyl", 0.05, 0.05, 1, 6],   color: 0x888888, y: 3.5 },               // antena
    { geo: ["sphere", 0.1, 8, 8],       color: 0xff0000, y: 4.05 },              // LED rojo
  ],
  postgres: [
    { geo: ["box", 2.5, 1.8, 1.5],      color: 0x336791, y: 0.9 },               // cuerpo
    { geo: ["cyl", 0.15, 0.15, 1.8, 8], color: 0xeeeeee, y: 0.9, x: -0.9, z: 0.7 },  // col 1
    { geo: ["cyl", 0.15, 0.15, 1.8, 8], color: 0xeeeeee, y: 0.9, x: -0.3, z: 0.7 },  // col 2
    { geo: ["cyl", 0.15, 0.15, 1.8, 8], color: 0xeeeeee, y: 0.9, x: 0.3, z: 0.7 },   // col 3
    { geo: ["cyl", 0.15, 0.15, 1.8, 8], color: 0xeeeeee, y: 0.9, x: 0.9, z: 0.7 },   // col 4
    { geo: ["box", 2.7, 0.2, 1.7],      color: 0x1f4868, y: 1.9 },               // tejado plano
    { geo: ["box", 2.2, 0.15, 0.4],     color: 0x666666, y: 0.075, z: 0.9 },     // escalera
  ],
  github: [
    { geo: ["box", 2.5, 1.5, 2],        color: 0xe6edf3, y: 0.75 },              // cuerpo
    { geo: ["spheredome", 1.4, 16, 8],  color: 0xe6edf3, y: 1.5 },               // cúpula curva
    { geo: ["box", 0.6, 1.1, 0.1],      color: 0x333333, y: 0.55, z: 1.0 },      // entrada
  ],
  linear: [
    { geo: ["cyl", 1.0, 1.0, 2.5, 5],   color: 0x5e6ad2, y: 1.25 },              // prisma pentagonal
    { geo: ["cyl", 1.05, 1.05, 0.1, 5], color: 0x3e4a8f, y: 2.55 },              // tejado pentagonal
  ],
  custom: [
    { geo: ["box", 1.5, 1.5, 1.5],      color: 0x6e7681, y: 0.75 },              // cuerpo
    { geo: ["cone", 1.2, 1, 4],         color: 0x4a505a, y: 2 },                 // tejado
  ],
};

function buildGeo(spec) {
  const [type, ...args] = spec;
  if (type === "box")        return new THREE.BoxGeometry(...args);
  if (type === "cone")       return new THREE.ConeGeometry(...args);
  if (type === "cyl")        return new THREE.CylinderGeometry(...args);
  if (type === "sphere")     return new THREE.SphereGeometry(...args);
  if (type === "spheredome") {
    // Hemisferio superior con base plana abajo
    return new THREE.SphereGeometry(args[0], args[1], args[2], 0, Math.PI * 2, 0, Math.PI / 2);
  }
  if (type === "circle")     return new THREE.CircleGeometry(...args);
  throw new Error(`Unknown geo type: ${type}`);
}

function buildBuilding(kind) {
  const recipe = BUILDING_RECIPES[kind] || BUILDING_RECIPES.custom;
  const group = new THREE.Group();
  group.userData = { type: "building", kind };
  for (const p of recipe) {
    const geo = buildGeo(p.geo);
    const mat = new THREE.MeshStandardMaterial({ color: p.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x || 0, p.y, p.z || 0);
    if (p.rotY) mesh.rotation.y = p.rotY;
    group.add(mesh);
  }
  return group;
}

// Helper: primer servicio con kind=vps por orden de id (estable por sesión).
// Devuelve null si no hay ningún VPS.
function firstVps(services) {
  return [...services]
    .filter(s => s && s.kind === "vps")
    .sort((a, b) => (a.id || "").localeCompare(b.id || ""))[0] || null;
}
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node --check "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/map3d.js" && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Smoke test con consola del navegador**

Reiniciar server. Hard refresh navegador. En la pestaña Mapa, abrir DevTools console y ejecutar:

```js
// Importar dinámicamente el módulo y pintar un edificio aislado para verificar
const mod = await import("/static/map3d.js");
// (no funcionará probar buildBuilding directo desde consola porque no se exporta;
// alternativa: comprobar que las constantes están definidas vía un check indirecto.
// Más simple: verificar en Network que map3d.js se sirve sin error sintáctico y
// que la pestaña Mapa se sigue cargando OK.)
```

Verificación más práctica: **abrir la pestaña Mapa y confirmar que el world view sigue funcionando** (con las primitivas viejas de F3/F4 todavía, porque `buildCity` aún no usa `buildCityCluster`). Si no hay error en consola, F5 task 2 está OK.

- [ ] **Step 4: Checkpoint** — `BUILDING_RECIPES`, `buildGeo`, `buildBuilding`, `firstVps` definidos y sin errores. El world view sigue como F4 porque aún no integramos cluster.

---

## Task 3: map3d.js — buildCityCluster + modificar buildCity (world view)

**Files:**
- Modify: `frontend/map3d.js` (añadir buildCityCluster al final + modificar buildCity)

- [ ] **Step 1: Añadir `buildCityCluster` al final del archivo**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// Construye un cluster mini para el world view de una ciudad:
// 1 edificio central (ayuntamiento o primer servicio) + hasta 4 secundarios + badge "+N más".
// Devuelve un THREE.Group con userData.serviceMeshMap = Map<serviceId, mesh>
// para que buildCity pueda construir cables después.
function buildCityCluster(services, client, project) {
  const cluster = new THREE.Group();
  const serviceMeshMap = new Map();
  cluster.userData = { type: "city-cluster", client, project, serviceMeshMap };
  if (!services || services.length === 0) return cluster;

  // Central: ayuntamiento (primer VPS) o, si no hay VPS, el primer servicio
  const central = firstVps(services) || services[0];

  // Resto, hasta CITY_CLUSTER_MAX - 1 secundarios
  const rest = services.filter(s => s.id !== central.id);
  const visible = rest.slice(0, CITY_CLUSTER_MAX - 1);
  const overflow = services.length - 1 - visible.length;

  // Construir central
  const centralMesh = buildBuilding(central.kind);
  centralMesh.scale.setScalar(CITY_CLUSTER_CENTRAL_SCALE);
  centralMesh.position.set(0, 0.15, 0);  // sobre el footprint (que tiene y=0.08)
  centralMesh.userData = { type: "zone", service: central, client, project };
  cluster.add(centralMesh);
  serviceMeshMap.set(central.id, centralMesh);

  // Offsets fijos para los 4 secundarios (esquinas de un cuadrado)
  const offsets = [
    { x:  2.5, z:  2.5 },
    { x: -2.5, z:  2.5 },
    { x:  2.5, z: -2.5 },
    { x: -2.5, z: -2.5 },
  ];
  visible.forEach((svc, i) => {
    const mesh = buildBuilding(svc.kind);
    mesh.scale.setScalar(CITY_CLUSTER_SECONDARY_SCALE);
    const o = offsets[i] || { x: 0, z: 0 };
    mesh.position.set(o.x, 0.15, o.z);
    mesh.userData = { type: "zone", service: svc, client, project };
    cluster.add(mesh);
    serviceMeshMap.set(svc.id, mesh);
  });

  // Badge "+N más" CSS2D si hay overflow
  if (overflow > 0) {
    const badgeDiv = document.createElement("div");
    badgeDiv.className = "cluster-more-badge";
    badgeDiv.textContent = "+" + overflow + " más";
    const badge = new CSS2DObject(badgeDiv);
    badge.position.set(0, 3, 0);
    cluster.add(badge);
  }

  return cluster;
}
```

- [ ] **Step 2: Modificar `buildCity` (F3) para usar `buildCityCluster`**

Localizar `buildCity(client, project, meta, worldPos)` en `frontend/map3d.js` (creada en F3). El cuerpo actual itera `services` y usa `buildZone` para crear cada primitiva. Hay que:
1. Reemplazar el loop de zones por una llamada a `buildCityCluster`.
2. Mantener footprint + label + cables.
3. Usar `cluster.userData.serviceMeshMap` para construir cables.

**Reemplazar** el bloque que va desde `// Zones` hasta el `return group;` (incluido) por:

```javascript
  // Cluster mini (Fase 5): 1 central + hasta 4 secundarios + badge overflow
  const cluster = buildCityCluster(services, client, project);
  group.add(cluster);

  // Mapeo serviceId → mesh (sacado del cluster), para construir cables
  const zoneMap = cluster.userData.serviceMeshMap;

  // Cables intra-ciudad (igual lógica que F3 pero usando los meshes del cluster)
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
};
```

**NOTA**: la implementación previa de `buildCity` también añadía el sub-label "ciudad sin zonas" cuando `services.length === 0`. Hay que conservarlo. Localizar el bloque que dice algo como:

```javascript
  if (services.length === 0) {
    const subDiv = document.createElement("div");
    subDiv.className = "city-sublabel";
    subDiv.textContent = "ciudad sin zonas";
    labelDiv.appendChild(subDiv);
  }
```

Ese bloque se queda como está (antes del cluster). Si por error se eliminó al sustituir, **re-añadirlo** justo después del bloque del label y antes de la línea `const cluster = buildCityCluster(...)`.

- [ ] **Step 3: Verificación en navegador**

Reiniciar server. Hard refresh. Esperado en la pestaña Mapa (world view):

- [ ] Cada ciudad se ve como cluster compacto SOBRE su footprint en lugar de primitivas individuales sueltas.
- [ ] DiveAcademy/Panel: ayuntamiento (VPS) al centro + un secundario al lado (el otro VPS).
- [ ] Si una ciudad tiene > 5 servicios → badge "+N más" CSS2D arriba del cluster (no aplica con el sandbox actual, pero verificar añadiendo servicios via curl o desde Proyectos).
- [ ] Hover, click, drag, fly-to: **funcionan exactamente igual** que F3/F4. Cero regresión.
- [ ] Conexiones (cables) entre servicios visibles del cluster: aparecen como líneas/curvas entre los mini-edificios.

- [ ] **Step 4: Checkpoint** — World view ahora muestra mini-ciudades cluster. Las interacciones siguen funcionando.

---

## Task 4: map3d.js — buildStreet + reescribir buildInterior (star topology)

**Files:**
- Modify: `frontend/map3d.js` (añadir buildStreet + addZoneLabel + reescribir buildInterior)

- [ ] **Step 1: Añadir `buildStreet` y `addZoneLabel` al final del archivo**

Editar `frontend/map3d.js`. **Al final del archivo** añadir:

```javascript
// Construye una "calle" radial: asfalto plano + líneas blancas dashed + label CSS2D.
// La calle se construye apuntando hacia +Z y luego se rota por `angle` rad alrededor de Y
// para apuntar al barrio correspondiente. `label` es el nombre del barrio (rol).
function buildStreet(angle, label) {
  const group = new THREE.Group();
  group.userData = { type: "interior-street", barrio: label };

  // Asfalto (BoxGeometry plano, eje principal Z)
  const asphalt = new THREE.Mesh(
    new THREE.BoxGeometry(STREET_WIDTH, 0.05, STREET_LENGTH),
    new THREE.MeshBasicMaterial({ color: 0x333740 })
  );
  asphalt.position.set(0, 0.04, STREET_RADIUS_START + STREET_LENGTH / 2);
  group.add(asphalt);

  // Línea blanca dashed centrada a lo largo de la calle
  const segments = 16;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const z = STREET_RADIUS_START + (i * STREET_LENGTH / segments);
    pts.push(new THREE.Vector3(0, 0.08, z));
  }
  const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
  const lineMat = new THREE.LineDashedMaterial({
    color: 0xffffff, dashSize: 0.3, gapSize: 0.3, linewidth: 1,
  });
  const line = new THREE.Line(lineGeo, lineMat);
  line.computeLineDistances();
  group.add(line);

  // Label al inicio de la calle (cerca de la plaza)
  if (label) {
    const lblDiv = document.createElement("div");
    lblDiv.className = "street-label";
    lblDiv.textContent = "calle " + label;
    const lbl = new CSS2DObject(lblDiv);
    lbl.position.set(0, 0.8, STREET_RADIUS_START + 0.5);
    group.add(lbl);
  }

  group.rotation.y = angle;
  return group;
}

// Helper compartido: añade label CSS2D con dot de estado al mesh del componente.
function addZoneLabel(mesh, svc) {
  const m = mockMetrics.get(svc.id);
  const statusCls = m ? `status-${m.status}` : "status-ok";
  const zlbl = document.createElement("div");
  zlbl.className = "zone-label";
  zlbl.dataset.serviceId = svc.id;
  zlbl.innerHTML = `<span class="status-dot ${statusCls}"></span><span>${escapeHtml(svc.name)} <span style="color:var(--muted);font-size:10px">[${escapeHtml(svc.kind)}]</span></span>`;
  const label = new CSS2DObject(zlbl);
  // Y fija en coords locales del mesh (escalado por COMPONENT_SCALE=2 → ~5 unidades en mundo)
  // Suficiente para que la label quede por encima de todos los edificios temáticos.
  label.position.set(0, 5, 0);
  mesh.add(label);
}
```

- [ ] **Step 2: Reemplazar `buildInterior` completo (versión F5 con star topology)**

Localizar la función `buildInterior = function(client, project) {...}` en `frontend/map3d.js` (asignada en F4). **Reemplazar** la función entera (desde `buildInterior = function(...)` hasta el cierre `};`) por:

```javascript
buildInterior = function(client, project) {
  const g = new THREE.Group();
  g.userData = { type: "interior", client, project };

  const cityRec = cityMap.get(`${client}/${project}`);
  const services = cityRec && cityRec.projectMeta && cityRec.projectMeta.services
    ? cityRec.projectMeta.services
    : [];

  // Empty state — ciudad sin servicios
  if (services.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "interior-empty";
    emptyDiv.innerHTML = '<strong>Ciudad vacía</strong>Añade servicios en el editor (Proyectos → Mapa)';
    const emptyLabel = new CSS2DObject(emptyDiv);
    emptyLabel.position.set(0, 1, 0);
    g.add(emptyLabel);
    return g;
  }

  // Agrupar por rol (mismo mapping kind→rol que F4)
  const byRole = new Map();
  for (const s of services) {
    const r = roleOf(s.kind);
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(s);
  }

  // Mapa serviceId → mesh global (cables se construyen al final)
  const interiorZoneMeshes = new Map();
  g.userData.interiorZoneMeshes = interiorZoneMeshes;

  // === PLAZA CENTRAL ============================================== //
  const infraServices = byRole.get("infraestructura") || [];
  const ayuntamiento = firstVps(infraServices);
  const infraOthers = infraServices.filter(s => !ayuntamiento || s.id !== ayuntamiento.id);

  if (ayuntamiento) {
    const mesh = buildBuilding(ayuntamiento.kind);
    mesh.scale.setScalar(COMPONENT_SCALE);
    mesh.position.set(0, 0, 0);
    mesh.userData = { type: "zone", service: ayuntamiento, client, project, inInterior: true };
    g.add(mesh);
    interiorZoneMeshes.set(ayuntamiento.id, mesh);
    addZoneLabel(mesh, ayuntamiento);

    // Label "plaza · ayuntamiento" arriba (alto fijo)
    const plazaDiv = document.createElement("div");
    plazaDiv.className = "barrio-label";
    plazaDiv.textContent = "plaza · ayuntamiento";
    const plazaLbl = new CSS2DObject(plazaDiv);
    plazaLbl.position.set(0, 7, 0);
    g.add(plazaLbl);
  } else {
    // Edge case: proyecto sin VPS
    const noayuntDiv = document.createElement("div");
    noayuntDiv.className = "barrio-label";
    noayuntDiv.textContent = "sin ayuntamiento";
    const lbl = new CSS2DObject(noayuntDiv);
    lbl.position.set(0, 1, 0);
    g.add(lbl);
  }

  // VPSs adicionales + dockers alrededor del ayuntamiento (radio PLAZA_RADIUS)
  const M = infraOthers.length;
  infraOthers.forEach((svc, i) => {
    const angle = (2 * Math.PI * i) / Math.max(M, 3);
    const x = PLAZA_RADIUS * Math.cos(angle);
    const z = PLAZA_RADIUS * Math.sin(angle);
    const mesh = buildBuilding(svc.kind);
    mesh.scale.setScalar(COMPONENT_SCALE);
    mesh.position.set(x, 0, z);
    mesh.userData = { type: "zone", service: svc, client, project, inInterior: true };
    g.add(mesh);
    interiorZoneMeshes.set(svc.id, mesh);
    addZoneLabel(mesh, svc);
  });

  // === BARRIOS NO-INFRA: CALLES RADIALES ========================== //
  const otherRoles = [...byRole.keys()].filter(r => r !== "infraestructura");
  const Nstreets = otherRoles.length;
  otherRoles.forEach((role, idx) => {
    const angle = (2 * Math.PI * idx) / Math.max(Nstreets, 1);
    const streetGroup = buildStreet(angle, role);

    const items = byRole.get(role);
    items.forEach((svc, i) => {
      const side = i % 2 === 0 ? 1 : -1;       // alternar lados
      const slot = Math.floor(i / 2);
      const localX = side * 1.6;
      const localZ = STREET_RADIUS_START + 1 + slot * 2;

      const mesh = buildBuilding(svc.kind);
      mesh.scale.setScalar(COMPONENT_SCALE);
      mesh.position.set(localX, 0, localZ);
      mesh.userData = { type: "zone", service: svc, client, project, inInterior: true };
      streetGroup.add(mesh);
      addZoneLabel(mesh, svc);

      // Aún dentro de streetGroup rotado, getWorldPosition funcionará bien
      // cuando construyamos los cables al final.
      interiorZoneMeshes.set(svc.id, mesh);
    });

    g.add(streetGroup);
  });

  // === CABLES INTRA-CIUDAD ======================================== //
  const connections = cityRec && cityRec.projectMeta && cityRec.projectMeta.connections
    ? cityRec.projectMeta.connections
    : [];
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
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0x333740 });
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
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node --check "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/map3d.js" && echo OK
```
Expected: `OK`.

- [ ] **Step 3: Verificación en navegador**

Hard refresh. Entrar a una ciudad. Esperado:

- [ ] Plaza central con el ayuntamiento (edificio temático VPS con cúpula dorada) en el origen.
- [ ] Si la ciudad tiene varios VPSs / dockers, aparecen alrededor del ayuntamiento (radio 3.5).
- [ ] Por cada barrio NO infraestructura (postgres / n8n / chatwoot / etc.), aparece una **calle radial** (rectángulo asfalto + líneas blancas dashed) saliendo de la plaza.
- [ ] Cada calle tiene su label CSS2D "calle <rol>" cerca de la plaza.
- [ ] Edificios alineados a ambos lados de cada calle, alternando.
- [ ] Cables intra-ciudad siguen conectando edificios por id (curvas asfalto + dashed encima).
- [ ] Sin VPSs → cartel "sin ayuntamiento" en la plaza, resto de barrios funcionan igual.
- [ ] Empty state (sin servicios) → cartel "Ciudad vacía".
- [ ] Esc / "← Volver al mundo" / side panel componente → funcionan exactamente igual que F4.

- [ ] **Step 4: Checkpoint** — Interior con star topology + edificios temáticos visibles. Side panel + mock metrics + Esc siguen funcionando.

---

## Task 5: map3d.css — estilos para street-label + cluster-more-badge

**Files:**
- Modify: `frontend/map3d.css` (añadir al final)

- [ ] **Step 1: Añadir estilos al final de `map3d.css`**

Editar `frontend/map3d.css`. **Al final del archivo** añadir:

```css
/* ============================================================ */
/* Fase 5 — Edificios temáticos + calles                         */
/* ============================================================ */

/* Label CSS2D al inicio de cada calle radial dentro del interior */
.street-label {
  background: rgba(13, 17, 23, 0.85);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 11px;
  text-transform: lowercase;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}

/* Badge "+N más" sobre el cluster mini del world cuando hay overflow */
.cluster-more-badge {
  background: rgba(94, 106, 210, 0.92);
  color: white;
  border-radius: 10px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  pointer-events: none;
  user-select: none;
  box-shadow: 0 0 6px rgba(94, 106, 210, 0.4);
}
```

- [ ] **Step 2: Verificación servida**

Run:
```bash
curl -s http://127.0.0.1:8788/static/map3d.css | grep -E "street-label|cluster-more-badge" | head -4
```
Expected: ambas reglas aparecen.

- [ ] **Step 3: Verificación visual rápida**

Hard refresh. Entrar a una ciudad con varios barrios. Esperado:

- [ ] Las labels "calle <rol>" se ven con estilo (fondo oscuro, borde, padding).

Para el badge "+N más" del cluster mini en world: añadir temporalmente más servicios (>5) a un proyecto desde curl o desde Proyectos para verificarlo.

```bash
# Ejemplo: meter 7 servicios en test-client/test-project
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"test-client","project":"test-project","services":[
    {"kind":"vps","name":"V1"},
    {"kind":"vps","name":"V2"},
    {"kind":"n8n","name":"N1"},
    {"kind":"postgres","name":"P1"},
    {"kind":"chatwoot","name":"C1"},
    {"kind":"docker","name":"D1"},
    {"kind":"github","name":"G1"}
  ],"connections":[]}'
```

Recargar el world view → la ciudad test-client/test-project debe mostrar 5 edificios mini + badge "+2 más" arriba del cluster.

- [ ] **Step 4: Checkpoint** — Estilos aplicados. Badge "+N más" visible cuando aplica.

---

## Task 6: Verificación end-to-end + commit único final

**Files:** ninguno (verificación) + commit final.

- [ ] **Step 1: Recorrer la checklist completa del spec**

Abrir `docs/superpowers/specs/2026-06-30-fase5-edificios-tematicos-design.md` sección 5 y verificar punto por punto:

**World view (mini-ciudades)**
- [ ] Cada ciudad se ve como cluster compacto.
- [ ] Edificio central = ayuntamiento VPS si existe, otro kind si no.
- [ ] Hasta 5 edificios visibles; > 5 → badge "+N más".
- [ ] Hover, click footprint, click edificio, drag: funcionan igual que F3/F4.

**Interior — star topology**
- [ ] Plaza central con ayuntamiento.
- [ ] VPSs/dockers adicionales alrededor (radio 3.5).
- [ ] Calles radiales por cada barrio no-infra.
- [ ] Calles renderizadas como asfalto + líneas blancas dashed.
- [ ] Edificios alineados a ambos lados de cada calle.
- [ ] Cables conectan edificios concretos.
- [ ] Proyecto sin VPS → cartel "sin ayuntamiento".
- [ ] Empty state → cartel "Ciudad vacía".

**Edificios temáticos**
- [ ] VPS = bloque + tejado + torre + cúpula dorada (ayuntamiento).
- [ ] n8n = torre alta con franjas verticales (oficina).
- [ ] postgres = cuerpo + 4 columnas + tejado plano + escalera (biblioteca).
- [ ] chatwoot = torre cilíndrica + antena + LED rojo.
- [ ] docker = base + contenedores apilados.
- [ ] github = bloque + cúpula curva + entrada.
- [ ] linear = prisma pentagonal + tejado pentagonal.
- [ ] custom = casa simple (cubo + tejado a dos aguas).

**Schema y persistencia**
- [ ] Schema v3: `interior_position` opcional, validado, defaults aplicados.
- [ ] `.panel.json` v1/v2 cargan sin error (backwards-compat).
- [ ] POST con `interior_position` fuera de rango → backend 400.

**No regresiones**
- [ ] Side panel enriquecido en interior funciona igual (Estado + Métricas + Config + Conexiones + botones).
- [ ] Esc encadenado (cancela drag / cierra panel / sale interior / fly-to-world).
- [ ] HUD adaptado.
- [ ] Drag en interior sigue desactivado.
- [ ] Pestaña Proyectos / Monitorización / Linear: idénticas.

Si algo falla → vuelve al Task correspondiente, arregla, repite.

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

Expected: modificados `backend/server.py`, `frontend/map3d.js`, `frontend/map3d.css`; nuevo `docs/superpowers/plans/2026-06-30-fase5-edificios-tematicos-plan.md`. NO debe aparecer `backend/panel.conf`.

- [ ] **Step 4: Stage selectivo**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && \
git add backend/server.py \
        frontend/map3d.js frontend/map3d.css \
        docs/superpowers/plans/2026-06-30-fase5-edificios-tematicos-plan.md
git status --short
```

Expected: 4 archivos staged, nada extra.

- [ ] **Step 5: Commit final**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git commit -m "$(cat <<'EOF'
feat(fase5): edificios temáticos + star topology + mini-ciudades en world

Upgrade visual del mapa 3D:
- frontend/map3d.js: nueva constante BUILDING_RECIPES (8 recetas
  declarativas de composición de primitivas: vps=ayuntamiento con cúpula,
  n8n=torre con franjas, postgres=biblioteca con columnas, chatwoot=torre
  con antena+LED, docker=almacén+contenedores, github=nave con cúpula,
  linear=prisma pentagonal, custom=casa) + buildGeo + buildBuilding +
  firstVps + buildStreet + buildCityCluster + addZoneLabel helper. Cero
  assets externos. Añadir/modificar un edificio = ~5-10 líneas de datos.
- buildCity (F3) modificado para usar buildCityCluster: cada ciudad en
  el world view ahora es un cluster compacto (1 central=ayuntamiento +
  hasta 4 secundarios + badge "+N más" si overflow).
- buildInterior (F4) reescrito con star topology: plaza central con
  ayuntamiento (firstVps) + VPSs/dockers adicionales alrededor (radio
  3.5), una calle radial por cada barrio no-infraestructura con edificios
  alineados a ambos lados (alternando), cables intra-ciudad como F4.

- frontend/map3d.css: estilos street-label + cluster-more-badge.

- backend/server.py: schema .panel.json bumpea a version 3. Nuevo campo
  opcional interior_position {x, z} por servicio (rango [-50, 50]),
  validado en validate_meta_payload, defaults aplicados en
  load_project_meta. Backwards-compat con v1/v2.

Las interacciones (hover, click, drag, fly-to, side panels, mock metrics,
Esc, HUD) funcionan exactamente igual que F3/F4. Cero regresión.

Caveats explícitos (a F6+):
- Drag-to-rearrange en interior: NO (schema preparado).
- Animaciones (luces, partículas, tráfico): NO.
- Modelos 3D externos: NO.
- Sonidos: NO.

Sin tests automatizados (criterio del proyecto). Verificación manual
con checklist del spec ejecutada con éxito.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0161kKVTR9U7cMCCVkEvFaDZ
EOF
)"
git log -1 --stat
```

- [ ] **Step 6: Checkpoint final** — Fase 5 completada y commiteada.

---

## Self-review (post-write)

**Spec coverage:** cada sección del spec tiene tarea.

- Sección 1 (UX: nueva pestaña Mapa, click city → cluster mini, click edificio → side panel) — Tasks 3 (cluster mini world) y 4 (interior con star topology). El side panel ya está en F4 sin cambios.
- Sección 2 (recetas de edificios + BUILDING_RECIPES + buildBuilding) → Task 2.
- Sección 3 (schema v3 + cambios backend mínimos) → Task 1.
- Sección 4 (arquitectura técnica: buildStreet + buildCityCluster + reescritura buildInterior + modificación buildCity) → Tasks 2, 3, 4.
- Sección 5 (verificación checklist + archivos + caveats) → Task 6 ejecuta la checklist.

**Placeholders:** ninguno. Todas las recetas, funciones y código están completos. No hay "TODO", "TBD", "implement later".

**Type consistency:**

- `BUILDING_RECIPES` consultado por `buildBuilding(kind)`. Cada pieza es `{geo: [type, ...args], color, y, x?, z?, rotY?}`. Tipos `geo`: `box, cone, cyl, sphere, spheredome, circle` — todos manejados por `buildGeo`.
- `userData.type === "zone"` con `userData.inInterior: true|undefined` — consistente con F3/F4 picking (raycaster pillará tanto los nuevos `buildBuilding` groups como las primitivas viejas si quedaran).
- `mockMetrics.get(svc.id)` reutilizado en `addZoneLabel` para el status-dot. Consistente con F4.
- `interiorZoneMeshes` Map → usado por `buildInterior` para cables. Mismo patrón que F4.
- `cluster.userData.serviceMeshMap` reusado por `buildCity` para cables. Patrón nuevo pero localmente coherente.
- `firstVps(services)` orden por id (`localeCompare`) → estable y consistente.
- `roleOf(kind)` reutilizado de F4 (mapping KIND_ROLE) sin cambios.
- `escapeHtml`, `humanUptime`, `statusText`, `disposeGroup`, `simpleHash`, `clamp` → ya existen, se reutilizan.

**Caveats de implementación:**

- `buildZone` (F3) queda como **función no usada** tras Task 3. No se elimina por compat; puede aparecer como warning de linter si se activa "unused-function". Aceptable; documentado.
- Las labels CSS2D dentro de meshes con scale=2 (COMPONENT_SCALE) se posicionan en y=5 LOCAL que se vuelve y=10 WORLD. Suficiente para que queden encima del edificio más alto (n8n escala 2 = altura ~9).
- Los edificios alineados en calles radiales no rotan para "mirar" hacia la calle. Postgres con columnas en +Z local seguirá teniendo las columnas en su orientación default. Aceptable para F5; orientación correcta es F6.
- Los offsets `(±2.5, ±2.5)` del cluster mini pueden chocar con el footprint plano (que es 10×10) y quedarse muy juntos. Si visualmente queda mal, ajustar `CITY_CLUSTER_*_SCALE` o offsets.
- `cluster.userData.serviceMeshMap` se accede desde `buildCity` justo después de crear el cluster. Si `buildCityCluster` cambia su estructura interna, ambas funciones deben mantenerse sincronizadas.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-fase5-edificios-tematicos-plan.md`. Dos opciones:**

**1. Inline Execution (recomendado para este plan)** — Ejecuto las 6 tareas en esta sesión con checkpoints en Tasks 2, 3, 4 y 6. Todo va a `map3d.js` + algo en CSS + 10 líneas backend; no se paraleliza bien.

**2. Subagentes por task** — Despacho un subagente fresco por cada task. Overhead grande (re-lectura de map3d.js que ya pasa de 1400 líneas).

¿Cuál prefieres?
