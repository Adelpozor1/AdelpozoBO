# Fase 4 — Interior de la ciudad — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir drill-in al interior de cada ciudad del mapa 3D: al pulsar "Entrar" en el side panel de una ciudad, la escena cambia a una vista interior donde se ven los servicios agrupados por barrios (uno por kind, footprints planos coloreados), los cables existentes renderizados como carreteras (tubo asfalto + líneas dashed), y al clicar un componente, el side panel se enriquece con bloques de estado y métricas simuladas (mock animado). Salida con Esc o botón HUD.

**Architecture:** Extiende el módulo existente `frontend/map3d.js` (~+500 líneas) con un sistema de `sceneMode` (`world` | `interior:<c>/<p>`) que oculta el `worldGroup` y muestra un nuevo `interiorGroup` con barrios polares (CircleGeometry alpha 0.25 por kind), componentes escala 2x dentro de cada barrio, y cables como TubeGeometry+LineDashedMaterial. Mock metrics en memoria con tick cada 2s, derivadas de hash(serviceId) para estabilidad por sesión. `openZonePanel` enriquecido condicionalmente según `userData.inInterior`. CSS nuevo en `map3d.css` (~+50 líneas) + un solo botón nuevo en `index.html` (`#mapBackBtn`).

**Tech Stack:** JavaScript ES modules vanilla, Three.js 0.160.0 self-hosted en `frontend/vendor/` (sin cambios), HTML5 + CSS3. Cero cambios backend (`backend/server.py` no se toca; `.panel.json` schema no cambia).

**Spec de referencia:** `docs/superpowers/specs/2026-06-30-fase4-interior-ciudad-design.md` (commit `82c6c13`).

**Política de commits:** **Un único commit al final** (Task 10). Cada task tiene un "Checkpoint" de verificación pero NO commitea.

---

## File structure

**Modificados (todos los cambios viven en estos 3 archivos):**

- `frontend/map3d.js` — añadir `sceneMode` y estado relacionado; `enterCity`, `exitCity`, `buildInterior` (barrios + componentes + carreteras); `initMockMetricsForServices`, `tickMockMetrics`, `refreshOpenPanelMetrics`, `humanUptime`, `simpleHash`, `clamp`; HUD adaptado (`showHudInterior`); `openZonePanel` y `openCityPanel` extendidos; `onKeyDown` y bloqueo de drag en interior.
- `frontend/map3d.css` — estilos para `.status-dot`, `.metric` (+ `.bar`), `.metric-uptime`, `.zone-label`, `.barrio-label`, `#mapBackBtn`.
- `frontend/index.html` — un solo botón nuevo dentro de `#mapHud` (`#mapBackBtn`), oculto por defecto.

**No tocados:** `backend/*` (sin cambios), `frontend/app.js` (sin cambios), `frontend/styles.css` (sin cambios), `frontend/vendor/*` (Three.js sin cambios), `.gitignore` (sin cambios).

**Creados:**

- `docs/superpowers/plans/2026-06-30-fase4-interior-ciudad-plan.md` (este documento).

---

## Task 1: HTML + CSS scaffolding (botón "Volver al mundo" + estilos nuevos)

**Files:**
- Modify: `frontend/index.html` (añadir 1 botón dentro de `#mapHud`)
- Modify: `frontend/map3d.css` (añadir bloque de estilos al final)

- [ ] **Step 1: Añadir `#mapBackBtn` dentro de `#mapHud` en `frontend/index.html`**

Localizar el bloque `<div id="mapHud">...</div>` en `frontend/index.html`. Tras Fase 3 contiene:

```html
    <div id="mapHud">
      <button id="mapEditToggle" class="hud-btn" title="Bloquea o desbloquea drag">🔒 Layout fijo</button>
      <button id="mapWorldBtn" class="hud-btn hidden" title="Volver al mundo">🌍 Ver mundo</button>
    </div>
```

Reemplazar por:

```html
    <div id="mapHud">
      <button id="mapEditToggle" class="hud-btn" title="Bloquea o desbloquea drag">🔒 Layout fijo</button>
      <button id="mapWorldBtn" class="hud-btn hidden" title="Volver al mundo (Fase 3)">🌍 Ver mundo</button>
      <button id="mapBackBtn" class="hud-btn hidden" title="Volver al mundo (Fase 4)">← Volver al mundo</button>
    </div>
```

(Cambio: nueva línea con `#mapBackBtn`; el `#mapWorldBtn` existente de Fase 3 se queda igual — es para "salir del fly-to", semántica distinta de `#mapBackBtn` que es "salir del interior".)

- [ ] **Step 2: Añadir CSS nuevo al final de `frontend/map3d.css`**

Editar `frontend/map3d.css`. **Al final del archivo** añadir:

```css
/* ============================================================ */
/* Fase 4 — Interior de la ciudad                                */
/* ============================================================ */

/* Botón "Volver al mundo" del HUD en interior */
#mapBackBtn {
  background: rgba(40, 55, 90, 0.92);
}
#mapBackBtn:hover {
  background: rgba(60, 75, 110, 0.95);
}

/* Indicador de estado (●) en labels y side panel */
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.status-ok   { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
.status-warn { background: #f59e0b; box-shadow: 0 0 4px #f59e0b; }
.status-down { background: #ef4444; box-shadow: 0 0 4px #ef4444; }

/* Bloque "Estado" del side panel en interior */
.sp-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
}
.sp-status-mock-note {
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
  margin-top: 4px;
}

/* Bloque "Métricas" del side panel en interior */
.metric {
  display: grid;
  grid-template-columns: 50px 50px 1fr;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  margin-bottom: 4px;
}
.metric .bar {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  height: 6px;
  overflow: hidden;
}
.metric .bar > div {
  background: var(--text);
  height: 100%;
  transition: width 1s ease-out;
}
.metric-uptime {
  font-size: 12px;
  color: var(--muted);
  margin-top: 6px;
}

/* Label CSS2D de zona en interior (con dot de estado) */
.zone-label {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(13, 17, 23, 0.92);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
}

/* Label CSS2D de barrio */
.barrio-label {
  background: rgba(13, 17, 23, 0.85);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 10px;
  font-size: 11px;
  text-transform: lowercase;
  pointer-events: none;
  user-select: none;
}

/* Empty state interior (ciudad sin servicios) */
.interior-empty {
  background: rgba(20, 30, 50, 0.92);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
  pointer-events: none;
  user-select: none;
}
.interior-empty strong {
  color: var(--text);
  display: block;
  margin-bottom: 4px;
  font-size: 14px;
}
```

- [ ] **Step 3: Reiniciar server local + verificación rápida**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
echo "== #mapBackBtn en index.html servida =="
curl -s http://127.0.0.1:8788/static/index.html | grep -E "mapBackBtn|mapEditToggle|mapWorldBtn"
echo "== CSS nuevos =="
curl -s http://127.0.0.1:8788/static/map3d.css | grep -E "status-dot|barrio-label|interior-empty|mapBackBtn" | head -6
```
Expected: las tres líneas de botones aparecen (`mapEditToggle`, `mapWorldBtn`, `mapBackBtn` en ese orden) y los selectores CSS nuevos están servidos.

- [ ] **Step 4: Checkpoint** — HTML y CSS scaffolding en sitio. Botón `#mapBackBtn` existe pero está oculto (clase `hidden`); cuando se active manualmente desde DevTools debe verse con el estilo azul.

Verificación opcional en navegador (Cmd+Shift+R primero):
```js
// en consola, con la pestaña Mapa abierta:
document.querySelector("#mapBackBtn").classList.remove("hidden");
// → debe aparecer el botón "← Volver al mundo" arriba derecha, azulado.
document.querySelector("#mapBackBtn").classList.add("hidden");
// → desaparece
```

---

## Task 2: map3d.js — Estado nuevo + helpers básicos + stubs vacíos

**Files:**
- Modify: `frontend/map3d.js` (añadir bloque al final del archivo)

- [ ] **Step 1: Añadir bloque "Fase 4 — interior" al final de `frontend/map3d.js`**

Editar `frontend/map3d.js`. **Al final del archivo** (después de `window.addEventListener("keydown", onKeyDown);`), añadir:

```javascript
// ============================================================ //
// Fase 4 — Interior de la ciudad (drill-in)                     //
// ============================================================ //

// Estado nuevo
let sceneMode = "world";              // "world" | "interior:<client>/<project>"
let interiorGroup = null;             // THREE.Group con el interior actual (null en world)
let worldCameraSnapshot = null;       // {position, frustumSize} para restaurar al salir
let savedEditModeBeforeEnter = false; // recordar Edit Mode al entrar para restaurar al salir
const mockMetrics = new Map();        // serviceId → {status, cpu, ram, disk, uptimeSeconds, lastUpdate}
let mockTicker = null;                // setInterval handle
const INTERIOR_FRUSTUM     = 25;
const INTERIOR_FRUSTUM_MIN = 10;
const INTERIOR_FRUSTUM_MAX = 40;
const BARRIO_RADIUS_SLOT   = 10;      // radio donde se posicionan los barrios
const BARRIO_FOOTPRINT_R   = 4;       // radio del footprint circular de un barrio
const COMPONENT_RADIUS     = 2;       // radio del círculo interior donde se colocan los componentes
const COMPONENT_SCALE      = 2;       // escala respecto a la primitiva del world

// Helpers --------------------------------------------------- //
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function simpleHash(str) {
  // DJB2 hash, devuelve uint32
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function humanUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function statusText(status) {
  return status === "ok"   ? "operativo"
       : status === "warn" ? "advertencia"
       :                     "caído";
}

// Stubs — se implementan en Tasks 3-7
let enterCity;
let exitCity;
let buildInterior;
let initMockMetricsForServices;
let startMockTicker;
let stopMockTicker;
let refreshOpenPanelMetrics;
let showHudInterior;
```

(Las funciones se declaran como `let` para poder asignarlas / sobreescribirlas en tasks siguientes sin redeclarar.)

- [ ] **Step 2: Implementar `showHudInterior` (visibilidad de botones HUD)**

En `frontend/map3d.js`, **al final del archivo** (después del bloque del Step 1), añadir:

```javascript
showHudInterior = function(inInterior) {
  const back = container.querySelector("#mapBackBtn");
  const edit = container.querySelector("#mapEditToggle");
  if (back) back.classList.toggle("hidden", !inInterior);
  if (edit) edit.classList.toggle("hidden", !!inInterior);
  // El botón "Ver mundo" (Fase 3) se gestiona con su propia lógica de fly-to;
  // no lo tocamos aquí.
};
```

- [ ] **Step 3: Wirear `#mapBackBtn` y nuevo botón "Entrar" del side panel de ciudad**

Localizar la función `bindWorldBtn()` en `frontend/map3d.js` (creada en Fase 3). **Reemplazar** por:

```javascript
function bindWorldBtn() {
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.onclick = () => flyToWorld();
  const bb = container.querySelector("#mapBackBtn");
  if (bb) bb.onclick = () => { if (typeof exitCity === "function") exitCity(); };
}
```

(Se mantiene el handler de `#mapWorldBtn` de Fase 3; se añade el de `#mapBackBtn`.)

- [ ] **Step 4: Añadir botón "» Entrar en la ciudad" al side panel reducido de ciudad**

Localizar la función `openCityPanel(cityGroup)` en `frontend/map3d.js` (creada en Fase 3). Dentro del `innerHTML`, localizar el bloque `<div class="sp-actions">...</div>`. Tras Fase 3 contiene:

```html
    <div class="sp-actions">
      <button class="btn" id="spOpenCity">Abrir editor</button>
      <button class="btn" id="spRenameCity">Renombrar proyecto</button>
      <button class="btn danger" id="spDeleteCity">Borrar proyecto</button>
    </div>
```

Reemplazar por:

```html
    <div class="sp-actions">
      <button class="btn primary" id="spEnterCity">» Entrar en la ciudad</button>
      <button class="btn" id="spOpenCity">Abrir editor</button>
      <button class="btn" id="spRenameCity">Renombrar proyecto</button>
      <button class="btn danger" id="spDeleteCity">Borrar proyecto</button>
    </div>
```

Y, justo después del bloque `sp.querySelector("#spCloseBtn").onclick = closeSidePanel;` dentro de la misma función (donde se cablean los handlers de los botones del side panel de ciudad), añadir como PRIMERA línea (antes de los otros handlers):

```javascript
  sp.querySelector("#spEnterCity").onclick = () => {
    if (typeof enterCity === "function") enterCity(ud.client, ud.project);
  };
```

- [ ] **Step 5: Verificación con stubs**

Reiniciar server (`pkill -f "python3 server.py" 2>/dev/null; sleep 1` + `cd backend && python3 server.py > ... &`). Recargar navegador (Cmd+Shift+R). En la pestaña Mapa, click sobre el footprint de una ciudad (no en una zona). Esperado:

- [ ] Side panel de ciudad aparece como hoy, pero con el botón "» Entrar en la ciudad" como primero en azul (clase `.primary`).
- [ ] Click "» Entrar en la ciudad" → en consola del navegador no debe haber error (la función `enterCity` aún es `undefined` así que el handler no hace nada, NO crash).
- [ ] Click "← Volver al mundo" tras forzarlo visible desde consola (`document.querySelector("#mapBackBtn").classList.remove("hidden"); document.querySelector("#mapBackBtn").click();`) → no debe crash (la función `exitCity` aún es `undefined`).

- [ ] **Step 6: Checkpoint** — Estado, helpers, HUD y botones cableados con stubs vacíos. Sin escena interior aún.

---

## Task 3: map3d.js — `enterCity` y `exitCity` (sceneMode, sin contenido aún)

**Files:**
- Modify: `frontend/map3d.js` (asignar las funciones stub)

- [ ] **Step 1: Implementar `enterCity` y `exitCity`**

En `frontend/map3d.js`, **al final del archivo** (después del bloque del Task 2), añadir:

```javascript
enterCity = function(client, project) {
  if (!client || !project) return;
  if (sceneMode.startsWith("interior:")) return;   // ya estás dentro

  // Snapshot cámara y Edit Mode actuales (para restaurar al salir)
  worldCameraSnapshot = {
    position: camera.position.clone(),
    frustumSize: camera.userData.frustumSize,
  };
  savedEditModeBeforeEnter = editMode;
  if (editMode) setEditMode(false);

  // Ocultar el mundo
  worldGroup.visible = false;

  // Cerrar side panel si estaba abierto (mostraba info de la ciudad)
  if (sidePanelOpen) closeSidePanel();

  // Construir interior (Task 4 implementa esto)
  interiorGroup = buildInterior(client, project);
  scene.add(interiorGroup);

  // Inicializar mock metrics si faltan (Task 6 implementa esto)
  if (typeof initMockMetricsForServices === "function") {
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) initMockMetricsForServices(rec.projectMeta.services || []);
  }

  // Cámara interior
  camera.position.set(50, 50, 50);
  setFrustum(INTERIOR_FRUSTUM);
  camera.lookAt(0, 0, 0);

  // sceneMode + HUD
  sceneMode = `interior:${client}/${project}`;
  if (typeof showHudInterior === "function") showHudInterior(true);

  // Mock ticker (Task 7 implementa)
  if (typeof startMockTicker === "function") startMockTicker();

  markDirty();
};

exitCity = function() {
  if (!sceneMode.startsWith("interior:")) return;

  // Parar mock ticker
  if (typeof stopMockTicker === "function") stopMockTicker();

  // Cerrar side panel si estaba abierto
  if (sidePanelOpen) closeSidePanel();

  // Disposer interior
  if (interiorGroup) {
    scene.remove(interiorGroup);
    disposeGroup(interiorGroup);
    interiorGroup = null;
  }

  // Volver a mostrar el mundo
  worldGroup.visible = true;

  // Restaurar cámara
  if (worldCameraSnapshot) {
    camera.position.copy(worldCameraSnapshot.position);
    setFrustum(worldCameraSnapshot.frustumSize);
    camera.lookAt(0, 0, 0);
    worldCameraSnapshot = null;
  }

  // Restaurar Edit Mode si estaba ON al entrar
  if (savedEditModeBeforeEnter) setEditMode(true);
  savedEditModeBeforeEnter = false;

  sceneMode = "world";
  if (typeof showHudInterior === "function") showHudInterior(false);

  markDirty();
};
```

- [ ] **Step 2: Stub temporal de `buildInterior` (devuelve grupo vacío con un placeholder)**

En `frontend/map3d.js`, justo después de las funciones del Step 1, añadir un stub temporal de `buildInterior` para que `enterCity` no rompa:

```javascript
// STUB temporal — Task 4 implementa esto de verdad
buildInterior = function(client, project) {
  const g = new THREE.Group();
  g.userData = { type: "interior", client, project };
  // Placeholder: una caja blanca pequeña para confirmar que el modo interior funciona
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(3, 3, 3),
    new THREE.MeshStandardMaterial({ color: 0xffffff, wireframe: true })
  );
  placeholder.position.set(0, 1.5, 0);
  g.add(placeholder);
  return g;
};
```

- [ ] **Step 3: Extender `onKeyDown` para que Esc encadene también con interior**

Localizar `onKeyDown` en `frontend/map3d.js` (creada en Fase 3, Task 9). **Reemplazar** la función completa por:

```javascript
function onKeyDown(ev) {
  if (ev.key !== "Escape") return;
  // 1. Cancelar drag en curso
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
  // 2. Cerrar side panel si abierto
  if (sidePanelOpen) { closeSidePanel(); return; }
  // 3. Si estás en interior, salir al mundo
  if (sceneMode.startsWith("interior:")) {
    if (typeof exitCity === "function") exitCity();
    return;
  }
  // 4. Edit Mode ON → desactivar
  if (editMode) { setEditMode(false); return; }
  // 5. Si no estás en vista mundo (zoom-in flotando), fly-to-world
  if (camera && camera.userData && camera.userData.frustumSize !== FRUSTUM_DEFAULT) {
    flyToWorld();
    return;
  }
}
```

(Cambios respecto a Fase 3: añadidos paso 3 — exit interior con Esc — y guardas con `typeof`.)

- [ ] **Step 4: Bloquear drag en interior (extender `onMouseDown`)**

Localizar la última reasignación de `onMouseDown` en `frontend/map3d.js` (Task 8 de Fase 3, donde se distingue click vs drag). El cuerpo de esa versión empieza con `if (ev.button === 0) mouseDownAt = ...` y delega al `_onMouseDown_v3`. Subir un nivel: localizar la versión anterior `onMouseDown = function(ev) { ... if (picked && editMode && (...zone|city-footprint)) { ... start drag ... } ... }` (Task 7 de Fase 3).

En esa versión, **modificar la guarda del drag** para que también requiera estar en world:

```javascript
  if (picked && editMode && sceneMode === "world" &&
      (picked.userData.type === "zone" || picked.userData.type === "city-footprint")) {
    // start drag
```

(Cambio: añadida la condición `sceneMode === "world"` al `if`.)

Esto asegura que aunque alguien active Edit Mode antes de entrar y luego entre (no debería poder, porque `showHudInterior` oculta el botón), el drag no se dispare en interior.

- [ ] **Step 5: Reiniciar server y verificar el cambio de modo**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
```

Hard refresh en navegador. Verificar:

- [ ] Click en el footprint de una ciudad → side panel con botón "» Entrar en la ciudad" como primera acción.
- [ ] Click "» Entrar en la ciudad" → la pradera y todas las ciudades desaparecen. En el origen aparece una caja blanca wireframe pequeña (placeholder del stub). HUD: aparece "← Volver al mundo", desaparece "🔒 Layout fijo".
- [ ] Cámara centrada en (50,50,50) → frustumSize=25 → vista cómoda.
- [ ] Click "← Volver al mundo" → la caja blanca desaparece, la pradera + ciudades vuelven, HUD vuelve a mostrar "🔒 Layout fijo". Cámara restaurada a donde estaba.
- [ ] Esc desde interior → mismo efecto que el botón.
- [ ] Esc con side panel abierto en world → cierra panel.

- [ ] **Step 6: Checkpoint** — Modo interior cambia, HUD se adapta, Esc encadenado funciona. Aún no se ven barrios ni componentes (solo el placeholder).

---

## Task 4: map3d.js — `buildInterior` real (barrios + componentes, sin cables aún)

**Files:**
- Modify: `frontend/map3d.js` (sustituir el stub de `buildInterior` por la versión real)

- [ ] **Step 1: Sustituir el stub de `buildInterior`**

En `frontend/map3d.js`, **localizar** el stub:

```javascript
// STUB temporal — Task 4 implementa esto de verdad
buildInterior = function(client, project) {
  const g = new THREE.Group();
  g.userData = { type: "interior", client, project };
  const placeholder = new THREE.Mesh(...);
  placeholder.position.set(0, 1.5, 0);
  g.add(placeholder);
  return g;
};
```

**Reemplazar** por la implementación real (sin cables todavía):

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

  // Agrupar por kind
  const byKind = new Map();
  for (const s of services) {
    if (!byKind.has(s.kind)) byKind.set(s.kind, []);
    byKind.get(s.kind).push(s);
  }

  const barrioKinds = [...byKind.keys()];
  const N = barrioKinds.length;

  // Mapa serviceId → mesh global (para que los cables del Task 5 puedan encontrarlos)
  const interiorZoneMeshes = new Map();
  g.userData.interiorZoneMeshes = interiorZoneMeshes;

  barrioKinds.forEach((kind, idx) => {
    const barrio = new THREE.Group();
    barrio.userData = { type: "barrio", kind };

    // Posición polar (N=1: centro)
    if (N === 1) {
      barrio.position.set(0, 0, 0);
    } else {
      const angle = (2 * Math.PI * idx) / N;
      barrio.position.set(
        BARRIO_RADIUS_SLOT * Math.cos(angle),
        0,
        BARRIO_RADIUS_SLOT * Math.sin(angle)
      );
    }

    // Footprint circular del barrio
    const color = ZONE_COLORS[kind] || ZONE_COLORS.custom;
    const footprintGeo = new THREE.CircleGeometry(BARRIO_FOOTPRINT_R, 32);
    const footprintMat = new THREE.MeshBasicMaterial({
      color, opacity: 0.25, transparent: true, side: THREE.DoubleSide,
    });
    const footprint = new THREE.Mesh(footprintGeo, footprintMat);
    footprint.rotation.x = -Math.PI / 2;
    footprint.position.y = 0.02;     // ligeramente sobre el ground
    footprint.userData = { type: "barrio-footprint", kind };
    barrio.add(footprint);

    // Label del barrio (arriba)
    const lblDiv = document.createElement("div");
    lblDiv.className = "barrio-label";
    lblDiv.textContent = `barrio ${kind}`;
    const barrioLabel = new CSS2DObject(lblDiv);
    barrioLabel.position.set(0, 0.5, 0);
    barrio.add(barrioLabel);

    // Componentes (zonas) dentro del barrio
    const items = byKind.get(kind);
    const M = items.length;
    items.forEach((svc, i) => {
      const angle = (2 * Math.PI * i) / Math.max(M, 3);
      const lx = COMPONENT_RADIUS * Math.cos(angle);
      const lz = COMPONENT_RADIUS * Math.sin(angle);

      const geoFactory = ZONE_PRIMITIVES[kind] || ZONE_PRIMITIVES.custom;
      const geo = geoFactory();
      const mat = new THREE.MeshStandardMaterial({ color });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(COMPONENT_SCALE, COMPONENT_SCALE, COMPONENT_SCALE);
      mesh.position.set(lx, ZONE_Y * COMPONENT_SCALE, lz);
      mesh.userData = {
        type: "zone",
        service: svc,
        client, project,
        inInterior: true,
      };
      barrio.add(mesh);
      interiorZoneMeshes.set(svc.id, mesh);

      // Label CSS2D con dot de estado (status se rellena correctamente cuando
      // mockMetrics esté disponible — Task 6)
      const m = mockMetrics.get(svc.id);
      const statusCls = m ? `status-${m.status}` : "status-ok";
      const zlbl = document.createElement("div");
      zlbl.className = "zone-label";
      zlbl.dataset.serviceId = svc.id;
      zlbl.innerHTML = `<span class="status-dot ${statusCls}"></span><span>${escapeHtml(svc.name)}</span>`;
      const label = new CSS2DObject(zlbl);
      label.position.set(0, 2.2, 0);
      mesh.add(label);
    });

    g.add(barrio);
  });

  return g;
};
```

- [ ] **Step 2: Verificación en navegador**

Hard refresh. Entrar a una ciudad con varios servicios (p. ej. DiveAcademy/Panel que tiene 2 VPS, o test-client/test-project si tiene 3 servicios). Esperado:

- [ ] Al entrar: barrios visibles como discos planos coloreados (alpha ~25%) distribuidos alrededor del origen.
- [ ] DiveAcademy/Panel: un solo barrio (`vps`) en el centro con los 2 boxes grises.
- [ ] test-client/test-project (si tiene varios kinds): 2-3 barrios distribuidos a 120° / 90°.
- [ ] Cada barrio tiene label CSS2D `barrio vps`, `barrio n8n`, etc.
- [ ] Componentes (boxes/cilindros) escala 2x dentro de cada barrio, en círculo interior.
- [ ] Cada componente tiene label `[●verde] nombre` arriba.
- [ ] Sin conexiones visibles aún (cables → Task 5).
- [ ] Entrar a una ciudad sin servicios → cartel central "Ciudad vacía. Añade servicios..." en lugar de barrios.

- [ ] **Step 3: Checkpoint** — Interior con barrios y componentes visible. Status dot verde por defecto (todos `status-ok` hasta Task 6).

---

## Task 5: map3d.js — Cables como carreteras dentro del interior

**Files:**
- Modify: `frontend/map3d.js` (extender `buildInterior` con la construcción de cables)

- [ ] **Step 1: Añadir construcción de cables al final de `buildInterior`**

En `frontend/map3d.js`, **localizar** la línea `return g;` al final de `buildInterior` (la única). Inmediatamente **antes** de `return g;`, añadir:

```javascript
  // Cables (intra-ciudad) renderizados como carreteras (tubo asfalto + dashed encima)
  const connections = cityRec && cityRec.projectMeta && cityRec.projectMeta.connections
    ? cityRec.projectMeta.connections
    : [];
  for (const conn of connections) {
    const from = interiorZoneMeshes.get(conn.from);
    const to   = interiorZoneMeshes.get(conn.to);
    if (!from || !to) continue;

    // Posiciones en coords mundo del interiorGroup (el barrio está dentro del g, así
    // que getWorldPosition incluye el offset del barrio + la posición local del mesh)
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    from.getWorldPosition(p0);
    to.getWorldPosition(p1);
    p0.y = ZONE_Y * 0.6;     // a ras de suelo, no a la altura del mesh
    p1.y = ZONE_Y * 0.6;

    // Curva suave entre los dos puntos (un punto intermedio elevado mínimamente
    // para que la dashed se vea bien)
    const mid = new THREE.Vector3()
      .addVectors(p0, p1).multiplyScalar(0.5);
    mid.y = ZONE_Y * 0.65;
    const curve = new THREE.CatmullRomCurve3([p0, mid, p1]);

    // Tubo asfalto
    const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.18, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0x333740 });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.userData = { type: "interior-road-asphalt", connection: conn };
    g.add(tube);

    // Líneas blancas dashed encima
    const segments = 48;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      pts.push(curve.getPoint(i / segments));
    }
    // levantar las líneas ligeramente sobre el tubo
    for (const p of pts) p.y += 0.05;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.5,
      gapSize: 0.5,
      linewidth: 1,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();    // requerido por LineDashedMaterial
    line.userData = { type: "interior-road-line", connection: conn };
    g.add(line);
  }
```

(Las dos `userData.type` `interior-road-asphalt` e `interior-road-line` no se usan para picking de momento — están ahí para tooltips futuros si se quieren. El raycaster del Task 5 de Fase 3 solo reacciona a `zone`, `city-footprint`, `cable`, así que las carreteras del interior no aparecerán en hover por ahora.)

- [ ] **Step 2: Verificación en navegador**

Hard refresh. Entrar a una ciudad que tenga conexiones (si ninguna las tiene, primero ve a Proyectos → entra al proyecto → sub-pestaña Mapa → "+ Añadir conexión" entre dos servicios → Guardar; luego vuelve a Mapa → Entrar). Esperado:

- [ ] Entre los componentes conectados aparece una carretera gris oscuro (tubo asfalto) con líneas blancas dashed encima.
- [ ] Carretera ligeramente curva (debido al punto intermedio elevado).
- [ ] Si no hay conexiones → solo barrios + componentes, sin carreteras (igual que Task 4).

- [ ] **Step 3: Checkpoint** — Cables como carreteras visibles dentro del interior.

---

## Task 6: map3d.js — Mock metrics: inicialización por hash

**Files:**
- Modify: `frontend/map3d.js` (asignar `initMockMetricsForServices`)

- [ ] **Step 1: Implementar `initMockMetricsForServices`**

En `frontend/map3d.js`, **al final del archivo**, añadir:

```javascript
initMockMetricsForServices = function(services) {
  for (const s of services) {
    if (mockMetrics.has(s.id)) continue;    // ya inicializado en esta sesión
    const h = simpleHash(s.id);
    const mod = h % 10;
    const status = mod < 7 ? "ok" : mod < 9 ? "warn" : "down";
    const cpu  = 20 + (h % 60);
    const ram  = 30 + ((h >>> 8) % 50);
    const disk = 10 + ((h >>> 16) % 70);
    const uptimeSeconds = 86400 + ((h >>> 4) % (86400 * 30));
    mockMetrics.set(s.id, {
      status, cpu, ram, disk, uptimeSeconds, lastUpdate: 0,
    });
  }
};
```

- [ ] **Step 2: Actualizar los status-dot de las labels CSS2D ya construidas**

Las labels del Task 4 ponen `status-ok` por defecto (porque `mockMetrics` aún no estaba inicializado al construir). `enterCity` (Task 3) inicializa metrics ANTES de añadir el `interiorGroup` a la escena, pero `buildInterior` se llamó ANTES de eso. Hay que invertir el orden o re-pintar las dot.

En `enterCity` (Task 3), localizar:

```javascript
  interiorGroup = buildInterior(client, project);
  scene.add(interiorGroup);

  // Inicializar mock metrics si faltan (Task 6 implementa esto)
  if (typeof initMockMetricsForServices === "function") {
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) initMockMetricsForServices(rec.projectMeta.services || []);
  }
```

**Reemplazar** por (orden invertido + repintar dots después):

```javascript
  // 1) Inicializar mock metrics primero
  if (typeof initMockMetricsForServices === "function") {
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) initMockMetricsForServices(rec.projectMeta.services || []);
  }

  // 2) Construir interior (las labels ya leerán el status correcto)
  interiorGroup = buildInterior(client, project);
  scene.add(interiorGroup);
```

- [ ] **Step 3: Verificación en navegador (console)**

Hard refresh. Entrar a una ciudad. En consola del navegador:

```js
// las labels deben tener dots con clase status-ok / status-warn / status-down según hash
document.querySelectorAll(".zone-label .status-dot").forEach(d => console.log(d.className, d.parentElement.querySelector("span:last-child").textContent));
```

Esperado: cada componente tiene status fijo (entrar/salir varias veces → sigue siendo el mismo color para ese servicio). La mayoría serán `status-ok` (70%), algunos `status-warn` (20%), pocos `status-down` (10%).

- [ ] **Step 4: Checkpoint** — Mock metrics inicializadas con valores estables por hash. Status dots reflejan el estado.

---

## Task 7: map3d.js — Ticker + `refreshOpenPanelMetrics`

**Files:**
- Modify: `frontend/map3d.js` (asignar `startMockTicker`, `stopMockTicker`, `refreshOpenPanelMetrics`)

- [ ] **Step 1: Implementar ticker y refresh**

En `frontend/map3d.js`, **al final del archivo**, añadir:

```javascript
startMockTicker = function() {
  if (mockTicker) return;
  mockTicker = setInterval(() => {
    if (!sceneMode.startsWith("interior:")) return;
    for (const m of mockMetrics.values()) {
      m.cpu  = clamp(m.cpu  + (Math.random() * 6 - 3), 0, 100);
      m.ram  = clamp(m.ram  + (Math.random() * 4 - 2), 0, 100);
      m.disk = clamp(m.disk + (Math.random() * 1 - 0.5), 0, 100);
      m.uptimeSeconds += 2;
      m.lastUpdate = Date.now();
    }
    if (typeof refreshOpenPanelMetrics === "function") refreshOpenPanelMetrics();
  }, 2000);
};

stopMockTicker = function() {
  if (mockTicker) {
    clearInterval(mockTicker);
    mockTicker = null;
  }
};

refreshOpenPanelMetrics = function() {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp || sp.classList.contains("hidden")) return;
  if (!sidePanelContext || sidePanelContext.type !== "zone") return;
  const id = sidePanelContext.serviceId;
  const m = mockMetrics.get(id);
  if (!m) return;
  const cpuTxt = Math.round(m.cpu) + "%";
  const ramTxt = Math.round(m.ram) + "%";
  const diskTxt = Math.round(m.disk) + "%";
  const upTxt = humanUptime(m.uptimeSeconds);
  const updateField = (sel, val) => { const el = sp.querySelector(sel); if (el) el.textContent = val; };
  const updateBar = (sel, val) => { const el = sp.querySelector(sel); if (el) el.style.width = val + "%"; };
  updateField('[data-metric="cpu"]',  cpuTxt);
  updateField('[data-metric="ram"]',  ramTxt);
  updateField('[data-metric="disk"]', diskTxt);
  updateField('[data-metric="uptime"]', upTxt);
  updateBar('[data-metric-bar="cpu"]',  Math.round(m.cpu));
  updateBar('[data-metric-bar="ram"]',  Math.round(m.ram));
  updateBar('[data-metric-bar="disk"]', Math.round(m.disk));
};
```

- [ ] **Step 2: Verificación rápida (sin panel enriquecido aún — Task 8)**

Hard refresh. Entrar a una ciudad. En consola del navegador:

```js
// Esperar 5 segundos y comprobar que mockMetrics ha cambiado
const before = JSON.parse(JSON.stringify([...document.querySelectorAll(".zone-label").length ? [] : []]));   // dummy
setTimeout(() => {
  // Comprobar via API interna: cualquier servicio del que sepamos el id
  // (pista: abre el panel → en sidePanelContext.serviceId; o saca el id de cityMap)
  console.log("ticker corriendo: si ves 'mockTicker' setInterval activo en DevTools / o si los valores en consola siguientes cambian al re-correr.");
}, 5000);
```

Realmente el ticker no es visible hasta el Task 8 (panel enriquecido) — confirma simplemente que NO hay errores en consola y que el setInterval está activo (DevTools → Sources → puedes pausar en el ticker y ver `m.cpu` cambiando).

Al salir de la ciudad (exitCity), `stopMockTicker` debe pararlo. Comprueba en DevTools → Performance/Memory que no queda timer activo.

- [ ] **Step 3: Checkpoint** — Ticker arranca al entrar a la ciudad y para al salir. Mock metrics se actualizan cada 2s.

---

## Task 8: map3d.js — `openZonePanel` enriquecido (bloques Estado + Métricas en interior)

**Files:**
- Modify: `frontend/map3d.js` (extender `openZonePanel` con bloques condicionales)

- [ ] **Step 1: Extender `openZonePanel` para detectar interior y añadir bloques**

Localizar la función `openZonePanel(zoneMesh)` en `frontend/map3d.js` (creada en Fase 3, Task 9). El cuerpo construye `sp.innerHTML` con varios bloques. **Reemplazar** la función completa por:

```javascript
function openZonePanel(zoneMesh) {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  const svc = zoneMesh.userData.service;
  const client = zoneMesh.userData.client;
  const project = zoneMesh.userData.project;
  const inInterior = !!zoneMesh.userData.inInterior;
  const meta = (cityMap.get(`${client}/${project}`) || {}).projectMeta || {};
  const connections = (meta.connections || []).filter(c => c.from === svc.id || c.to === svc.id);
  const nameOf = id => {
    const m = (meta.services || []).find(x => x.id === id);
    return m ? m.name : id;
  };

  // Bloques condicionales: solo en interior, mostrar Estado y Métricas
  let estadoBlock = "";
  let metricasBlock = "";
  if (inInterior) {
    const m = mockMetrics.get(svc.id) || { status: "ok", cpu: 0, ram: 0, disk: 0, uptimeSeconds: 0 };
    const cpuTxt = Math.round(m.cpu) + "%";
    const ramTxt = Math.round(m.ram) + "%";
    const diskTxt = Math.round(m.disk) + "%";
    const upTxt = humanUptime(m.uptimeSeconds);
    estadoBlock = `
      <div class="sp-block">
        <h4>Estado (simulado)</h4>
        <div class="sp-status-row">
          <span class="status-dot status-${m.status}"></span>
          <span>${escapeHtml(statusText(m.status))}</span>
        </div>
        <div class="sp-status-mock-note">datos simulados · conectar Fase 2 para datos reales</div>
      </div>`;
    metricasBlock = `
      <div class="sp-block">
        <h4>Métricas (simuladas)</h4>
        <div class="metric"><span>CPU</span><span data-metric="cpu">${cpuTxt}</span>
          <div class="bar"><div data-metric-bar="cpu" style="width:${Math.round(m.cpu)}%"></div></div></div>
        <div class="metric"><span>RAM</span><span data-metric="ram">${ramTxt}</span>
          <div class="bar"><div data-metric-bar="ram" style="width:${Math.round(m.ram)}%"></div></div></div>
        <div class="metric"><span>Disk</span><span data-metric="disk">${diskTxt}</span>
          <div class="bar"><div data-metric-bar="disk" style="width:${Math.round(m.disk)}%"></div></div></div>
        <div class="metric-uptime">Uptime: <span data-metric="uptime">${escapeHtml(upTxt)}</span></div>
      </div>`;
  } else {
    estadoBlock = `
      <div class="sp-block">
        <h4>Estado</h4>
        <div class="sp-placeholder">Monitor en vivo: disponible en Fase 2</div>
      </div>`;
  }

  sp.innerHTML = `
    <div class="sp-header">
      <div>
        <div class="sp-breadcrumb">${escapeHtml(client)} / ${escapeHtml(project)}</div>
        <div class="sp-title">${escapeHtml(svc.name)}</div>
        <div class="svc-kind-badge">${escapeHtml(svc.kind)}</div>
      </div>
      <button class="sp-close" id="spCloseBtn">×</button>
    </div>
    ${estadoBlock}
    ${metricasBlock}
    <div class="sp-block">
      <h4>Config</h4>
      <pre class="sp-config-json">${escapeHtml(JSON.stringify(svc.config || {}, null, 2))}</pre>
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
```

(Cambios respecto a Fase 3: detección de `inInterior`, dos nuevos bloques `estadoBlock` y `metricasBlock` que sustituyen al `Estado` placeholder en interior; en world se queda como antes.)

- [ ] **Step 2: Verificación end-to-end**

Hard refresh. Entrar a una ciudad. Click sobre un componente. Esperado:

- [ ] Side panel slide-in desde la derecha.
- [ ] **Bloque "Estado (simulado)"** con un `●` colorado según status + texto "operativo|advertencia|caído" + nota gris "datos simulados · conectar Fase 2 para datos reales".
- [ ] **Bloque "Métricas (simuladas)"** con CPU/RAM/Disk como filas con valor y barra de progreso, + línea "Uptime: 3d 12h".
- [ ] Esperar 2 segundos: los valores numéricos y las barras cambian sutilmente. Sin parpadeo del panel entero.
- [ ] Cerrar panel (botón ×) y reabrirlo (click en el mismo componente): los valores son distintos a los originales (ha pasado el tiempo).

Click sobre un componente EN MODO MUNDO (NO en interior — sal de la ciudad y abre un cubo desde el world):

- [ ] Panel aparece **sin** los bloques Estado/Métricas enriquecidos. En su lugar, el bloque Estado dice "Monitor en vivo: disponible en Fase 2" (placeholder estático). **No regresión** de Fase 3.

- [ ] **Step 3: Checkpoint** — Side panel enriquecido en interior con métricas que se actualizan en vivo; world panel sin cambios.

---

## Task 9: map3d.js — Empty state interior + bloqueo de drag en interior (verificación)

**Files:**
- ninguno (verificación de comportamiento ya integrado)

- [ ] **Step 1: Verificar empty state interior**

Para forzar una ciudad vacía: en consola del navegador, crear un proyecto sin servicios desde la pestaña Proyectos (+ Nuevo cliente "test-empty" → entrar → + Nuevo proyecto "vacio"). Luego volver a Mapa → ver que aparece una nueva ciudad sin zonas (debería tener footprint + label + sub-label "ciudad sin zonas" — ese cartelito ya lo pone `buildCity` en Fase 3 cuando `services.length === 0`). Click en su footprint → side panel con botón "» Entrar en la ciudad" → click "Entrar".

Esperado:

- [ ] El interior aparece **sin barrios** (no hay kinds), pero con un cartel central CSS2D "Ciudad vacía / Añade servicios en el editor (Proyectos → Mapa)" tal como define `buildInterior` cuando `services.length === 0`.
- [ ] HUD: "← Volver al mundo" visible. Click vuelve al mundo normalmente.
- [ ] Esc también vuelve.

- [ ] **Step 2: Verificar bloqueo de drag en interior**

Hard refresh. En el mundo, click "🔒 Layout fijo" para activar Edit Mode (cambia a "✏️ Modo edición"). Luego, click ciudad → "» Entrar en la ciudad".

Esperado:

- [ ] Al entrar, el botón "🔒 Layout fijo / ✏️ Modo edición" se oculta (`showHudInterior(true)`). Solo se ve "← Volver al mundo".
- [ ] Intentar arrastrar un componente del interior → NO se mueve (el guard `sceneMode === "world"` en `onMouseDown` lo impide).
- [ ] Click "← Volver al mundo" → vuelve al mundo + Edit Mode se RESTAURA al estado en que estaba antes de entrar (ON, gracias a `savedEditModeBeforeEnter`). El componente del world ya se puede arrastrar otra vez.

- [ ] **Step 3: Verificar "Borrar zona" desde interior**

Hard refresh. Entrar a una ciudad. Click sobre una zona → side panel → "Borrar zona" → confirmar. Esperado:

- [ ] La zona desaparece del barrio. Si era la única del barrio, el barrio desaparece. Si era la última del proyecto, queda empty state. Side panel se cierra.
- [ ] (Nota: en Fase 3, `deleteZoneFromPanel` llama a `doPersist` y luego `rebuildCity(client, project)` — esto reconstruye la ciudad en el `worldGroup`, NO en el `interiorGroup`. Esto significa que tras borrar una zona desde interior, el interior NO se refresca automáticamente. **El interior visible queda "obsoleto" hasta que sales y vuelves a entrar.** Aceptable como degradación menor en Fase 4; si molesta, se arregla con un refresh explícito tras `doPersist` cuando `sceneMode` es interior. Documentado como caveat — ver Step 4.)

- [ ] **Step 4: Aplicar fix de refresh tras borrar en interior**

Para no dejar el interior obsoleto, parchear `deleteZoneFromPanel` en `frontend/map3d.js` (función de Fase 3, Task 9). **Localizar** el cuerpo de la función:

```javascript
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
```

**Reemplazar** por:

```javascript
async function deleteZoneFromPanel(client, project, serviceId) {
  if (!confirm("¿Borrar esta zona? También se borrarán sus conexiones.")) return;
  const rec = cityMap.get(`${client}/${project}`);
  if (!rec) return;
  const meta = rec.projectMeta;
  meta.services = (meta.services || []).filter(s => s.id !== serviceId);
  meta.connections = (meta.connections || []).filter(c => c.from !== serviceId && c.to !== serviceId);
  await doPersist(client, project, meta);
  // Reconstruye la representación del world
  rebuildCity(client, project);
  // Si estamos en el interior de esa misma ciudad, también reconstruye el interior
  if (sceneMode === `interior:${client}/${project}` && interiorGroup) {
    scene.remove(interiorGroup);
    disposeGroup(interiorGroup);
    interiorGroup = buildInterior(client, project);
    scene.add(interiorGroup);
  }
  closeSidePanel();
  markDirty();
}
```

- [ ] **Step 5: Verificación del fix**

Hard refresh. Entrar a una ciudad. Borrar una zona del side panel. Esperado:

- [ ] La zona desaparece del interior inmediatamente, sin tener que salir y volver a entrar.
- [ ] Si era la única del barrio → el barrio desaparece.
- [ ] Si era la última del proyecto → aparece el empty state "Ciudad vacía".

- [ ] **Step 6: Checkpoint** — Empty state interior funciona. Drag bloqueado correctamente. Borrado desde interior refresca el interior.

---

## Task 10: Verificación end-to-end + commit único final

**Files:** ninguno (verificación) + commit final.

- [ ] **Step 1: Recorrer la checklist completa del spec**

Abrir `docs/superpowers/specs/2026-06-30-fase4-interior-ciudad-design.md` sección 4 y verificar punto por punto:

**Entrada/salida**
- [ ] Click ciudad → side panel reducido con botón "» Entrar" como primero.
- [ ] Click "Entrar" → world oculto, interior visible.
- [ ] Cámara centrada (50,50,50), frustumSize≈25.
- [ ] HUD: aparece "← Volver al mundo", oculto "🔒 Layout fijo".
- [ ] Click "← Volver al mundo" → world restaurada exactamente.
- [ ] Esc con panel abierto → cierra panel. Otro Esc → exitCity.
- [ ] Esc sin panel → exitCity directamente.

**Layout interior**
- [ ] N=1 barrio → centrado.
- [ ] N≥2 → polar a 360/N°, radio 10.
- [ ] Cada barrio: footprint circular alpha 0.25 con color del kind + label CSS2D.
- [ ] Componentes escala 2x en círculo interior radio 2.
- [ ] Label componente: `[●] <nombre>` con color del status.
- [ ] Cables intra-ciudad: tubo asfalto + líneas blancas dashed.
- [ ] Sin conexiones → no hay carreteras.

**Mock metrics**
- [ ] Status fijo por sesión (entrar/salir varias veces → mismo status para mismo servicio).
- [ ] cpu/ram/disk/uptime iniciales derivados de hash.
- [ ] Tick cada 2s: valores con jitter, uptime +2s.
- [ ] Side panel abierto: números se actualizan en vivo sin parpadeo del panel.
- [ ] Cartel "datos simulados · conectar Fase 2" visible.

**Side panel**
- [ ] Click componente en interior → panel enriquecido con Estado + Métricas + Config + Conexiones + botones.
- [ ] Click componente en world → panel como Fase 3 (sin Métricas).
- [ ] "Editar en formulario" desde interior → navega a Proyectos / cliente / proyecto / Mapa.
- [ ] "Borrar zona" desde interior → desaparece + conexiones huérfanas limpiadas + interior se refresca (Task 9 Step 4).

**Empty state interior**
- [ ] Ciudad vacía → cartel central "Ciudad vacía. Añade servicios...".

**No regresiones de Fase 3**
- [ ] World mode: pan, zoom, drag, fly-to, side panel ciudad (con nuevo botón Entrar), side panel zona, todo funciona.
- [ ] Pestaña Proyectos / Monitorización / Linear: idénticas.
- [ ] Tras CRUD en Proyectos → world se refresca.

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

Expected: deben aparecer modificados `frontend/index.html`, `frontend/map3d.js`, `frontend/map3d.css`, y como nuevo `docs/superpowers/plans/2026-06-30-fase4-interior-ciudad-plan.md`. NO debe aparecer `backend/panel.conf` ni nada del sandbox `projects_dir`.

- [ ] **Step 4: Stage selectivo**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && \
git add frontend/index.html frontend/map3d.js frontend/map3d.css \
        docs/superpowers/plans/2026-06-30-fase4-interior-ciudad-plan.md
git status --short
```

Expected: 4 archivos staged, nada extra.

- [ ] **Step 5: Commit final con HEREDOC**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git commit -m "$(cat <<'EOF'
feat(fase4): interior de la ciudad con barrios, carreteras y métricas mock

- frontend/map3d.js: nuevo sceneMode (world | interior:<c>/<p>) con
  enterCity/exitCity que ocultan el worldGroup y muestran un interiorGroup
  con barrios automáticos por kind (footprints circulares alpha 0.25
  coloreados) distribuidos en polar, componentes escala 2x dentro de cada
  barrio, y los cables existentes renderizados como carreteras (TubeGeometry
  asfalto + LineDashedMaterial blancas encima). Mock metrics en memoria
  con tick cada 2s, derivadas de hash(serviceId) para estabilidad por
  sesión. openZonePanel enriquecido condicionalmente con bloques Estado y
  Métricas en interior; mismo panel limpio en world (sin regresión F3).
  HUD adaptado: edit toggle se oculta en interior, aparece "← Volver al
  mundo". Esc encadena: cancela drag / cierra panel / sale interior / sale
  Edit Mode / fly-to-world. Drag de componentes bloqueado en interior.
  deleteZoneFromPanel refresca también el interior si estás dentro.

- frontend/map3d.css: status-dot (ok/warn/down), .metric con barras, label
  CSS2D enriquecido con dot de estado, barrio-label, empty state interior,
  estilo del nuevo botón #mapBackBtn.

- frontend/index.html: un solo botón nuevo (#mapBackBtn) dentro del HUD,
  oculto por defecto.

- docs: plan en docs/superpowers/plans/.

Backend: cero cambios. Schema .panel.json sin cambios. Las métricas son
mock animado totalmente en memoria del cliente; cuando llegue Fase 2 (ingesta
real por kind), las mismas casillas del side panel se rellenarán con datos
reales sin rediseñar UI.

Sin tests automatizados (criterio del proyecto). Verificación manual con
checklist del spec ejecutada con éxito.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0161kKVTR9U7cMCCVkEvFaDZ
EOF
)"
git log -1 --stat
```

- [ ] **Step 6: Checkpoint final** — Fase 4 completada y commiteada.

---

## Self-review (post-write)

**Spec coverage:** cada sección del spec tiene tarea.

- Sección 1 (UX/alcance: botón "Entrar", sceneMode, HUD adaptado, empty state, salida con Esc/HUD) → Tasks 1, 2, 3, 9.
- Sección 2 (modelo de datos: .panel.json sin cambios, mockMetrics en memoria, hash inicial, tick 2s) → Tasks 2 (helpers), 6 (init), 7 (ticker).
- Sección 3 (arquitectura: estado nuevo, enterCity/exitCity, buildInterior con barrios polares + componentes 2x + cables como carreteras, mock ticker, side panel enriquecido, HUD adaptado, drag bloqueado, CSS) → Tasks 1 (CSS), 2 (estado), 3 (enter/exit), 4 (barrios+componentes), 5 (cables), 6 (mock init), 7 (ticker), 8 (panel enriquecido).
- Sección 4 (checklist, archivos, caveats) → Task 10 ejecuta la checklist.

**Placeholders:** los stubs `let enterCity; let exitCity; let buildInterior; ...` del Task 2 son contratos cruzados explícitos asignados en Tasks 3-7. No son placeholders sino documentación de orden. El stub temporal de `buildInterior` (Task 3 Step 2 / Task 4 Step 1) está señalado con comentario `STUB temporal — Task 4 implementa esto de verdad` y se reemplaza en Task 4.

**Type consistency:**

- `mockMetrics: Map<serviceId, {status, cpu, ram, disk, uptimeSeconds, lastUpdate}>` — consistente entre `initMockMetricsForServices` (Task 6), `startMockTicker` (Task 7), `refreshOpenPanelMetrics` (Task 7), `openZonePanel` enriquecido (Task 8).
- `sceneMode: "world" | "interior:<client>/<project>"` — consistente entre `enterCity`, `exitCity`, `onMouseDown` guard, `onKeyDown`, `startMockTicker`.
- `userData.inInterior: true` — set en `buildInterior` (Task 4) y leído en `openZonePanel` (Task 8). Consistente.
- `interiorZoneMeshes: Map<serviceId, mesh>` — guardado en `g.userData.interiorZoneMeshes` (Task 4) y usado por la construcción de cables (Task 5).
- `ZONE_PRIMITIVES` y `ZONE_COLORS` — reusados de Fase 3, sin redeclaración.
- `escapeHtml` y `humanUptime` — `escapeHtml` ya existe en Fase 3 (definida en Task 9 de F3 plan, está disponible en el módulo); `humanUptime` se define en Task 2 (F4).
- `disposeGroup` — ya existe (Task 4 de Fase 3, definido en map3d.js).
- `sidePanelContext` — ya existe (Task 9 de Fase 3); refreshOpenPanelMetrics lo lee con `sidePanelContext.serviceId`.
- `CSS2DObject` — ya importado en map3d.js (Fase 3 Task 3).
- `CatmullRomCurve3`, `TubeGeometry`, `LineDashedMaterial`, `LineBasicMaterial`, `BufferGeometry` — todos vienen de `THREE`, ya importado.

**Caveats de implementación:**

- Reasignación de funciones declaradas como `let X; ... X = function() {...}`: depende de que el código se evalúe en orden. Funciona porque los handlers (botones del HUD, click handlers) usan `if (typeof X === "function") X()` o se cablean DESPUÉS de las asignaciones. Verificado en Task 3 Step 3 con el wrap del bindWorldBtn.
- `simpleHash` (DJB2) puede colisionar para algunos ids cortos, pero los ids son `kind-XXXX` (6+ chars) con secrets.token_hex(2) → suficiente entropía para la estabilidad por sesión.
- `LineDashedMaterial.linewidth` siempre vale 1 en WebGL desktop (limitación conocida); no se puede hacer más gruesa la línea blanca sin usar Line2/LineGeometry. Aceptable.
- El `box-shadow` en `.status-dot` puede no renderizarse perfecto dentro de un label CSS2D escalado por la cámara. Aceptable.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-fase4-interior-ciudad-plan.md`. Dos opciones:**

**1. Inline Execution (recomendado para este plan)** — Ejecuto las 10 tareas en esta sesión con checkpoints en Tasks 3, 5, 8 y 10. Todas las dependencias son secuenciales dentro del mismo archivo `map3d.js`, no hay forma realista de paralelizar.

**2. Subagent-Driven** — Despacho un subagente fresco por task. Contexto limpio pero mucho overhead de re-lectura.

¿Cuál prefieres?
