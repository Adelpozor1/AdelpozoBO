# Fase 7 — Reset del frontend a 2D simple (HTML grid) + completar polling backend

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

Las Fases 3-5 entregaron un mapa 3D isométrico (Three.js) con barrios, edificios temáticos, mini-ciudades en world view y star topology en interior. La Fase 6 empezó un rediseño VPS-céntrico con monitor real (polling backend + carreteras vivas), pero a mitad de la implementación el usuario pidió **simplificar todo**: "quiero que sea mucho más básico, si tiene que ser en 2D hazlo".

La Fase 7 hace ese reset: **borra todo el 3D** (Three.js, CSS2DRenderer, todos los `buildBuilding`/`buildInterior`/etc.) y lo reemplaza por una vista **grid de tarjetas HTML/CSS plano**. Sin canvas, sin SVG, sin libs. La parte de backend (validación schema v4 + polling daemon de monitor) que F6 dejó WIP se mantiene y se **completa** en esta fase, porque sirve igual para 2D que para 3D.

## Decisiones tomadas

1. **Vista 2D = grid de tarjetas HTML/CSS** (sin canvas, sin SVG, sin libs externas). Mobile-friendly automáticamente con CSS responsive.
2. **3D actual se borra** (`map3d.js`, `map3d.css`, `vendor/three.module.js`, `vendor/CSS2DRenderer.js`, importmap, overlays HUD/canvas). La pestaña "Mapa" del header pasa a renderizar la nueva vista 2D.
3. **Backend WIP mantenido y completado**: validación cruzada `on_host`/`satellites_of` v4 (ya hecho) + polling daemon `health_poll_loop` + endpoint `/api/projects/health` (completar lo que el worker no terminó).
4. **Click en tarjeta VPS = expand inline** (acordeón). Sin side panel, sin cambio de página. Toda la info de un VPS se ve en su propia tarjeta expandida.
5. **Modelo de datos**: schema v4 con `config.on_host` y `config.satellites_of` (como aprobamos en F6).
6. **Polling frontend cada 30s**: misma cadencia que backend, actualiza estado e iconos in-place sin recargar.
7. **Formulario sub-pestaña Mapa de F1**: NO se toca. El selector "Alojado en VPS" del formulario (tarea F6) se mete también en este spec como parte del trabajo a completar.
8. **Pestañas Linear / Monitorización / Proyectos del header**: sin cambios.
9. **Sin tests automatizados** (mismo criterio F1-F6).

## Sección 1 — UX

### Vista principal: grid de tarjetas

Cuando entras a la pestaña "Mapa" (default al loguearse):

```
╔════════════════════════════════════════════════════════════════════╗
║  Mapa de infraestructura                              [↻ refrescar]║
╠════════════════════════════════════════════════════════════════════╣
║  Cliente: DiveAcademy                                              ║
║  ┌────────────────────────────┐  ┌────────────────────────────┐    ║
║  │ 🟢 VPS Hostinger DiveAcad. │  │ ⛔ VPS LAN 192.168.1.29    │    ║
║  │ 76.13.63.235  ·  proj:Panel│  │ 192.168.1.29 · proj:Panel  │    ║
║  │ CPU 24%  RAM 65%  Disk 38% │  │ (sin datos)                │    ║
║  │ [n8n_prod] [pgsql_main]    │  │ (sin servicios alojados)   │    ║
║  │ +[github:repo] satélite    │  │                            │    ║
║  └────────────────────────────┘  └────────────────────────────┘    ║
║                                                                    ║
║  Cliente: test-client                                              ║
║  ┌────────────────────────────┐                                    ║
║  │ ⚠️ Test VPS                │                                    ║
║  │ ...                        │                                    ║
║  └────────────────────────────┘                                    ║
╚════════════════════════════════════════════════════════════════════╝
```

- **Sección por cliente** con `<h2>Cliente: X</h2>`.
- **Grid responsive** (`grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`) con tarjetas de VPS.
- **Cada tarjeta colapsada** muestra:
  - Header: icono estado (🟢/⚠️/⛔) + nombre VPS.
  - Sub-header: IP + nombre proyecto.
  - Métricas en línea: CPU%, RAM%, Disk% (o "sin datos" si polling aún no respondió).
  - Lista compacta de servicios alojados (chips) + satélites SaaS.
- **Click en tarjeta → expand** (acordeón):
  - Aparecen sub-bloques: Config JSON del VPS, lista expandida de servicios alojados (cada uno como mini-card con su kind/config), lista de satélites, acciones (Borrar zona, Editar en formulario).
  - Click otra vez (header) → colapsa.
- **Empty state**: si no hay clientes/proyectos con VPSs, mensaje central "Aún no tienes VPSs. Crea una desde Proyectos → Mapa".
- **Auto-refresh**: polling cada 30s actualiza status icons y métricas sin desmontar el DOM (modifica el texto in-place). El acordeón abierto sigue abierto.
- **Botón "↻ refrescar"** en el header: fuerza fetch inmediato sin esperar al timer.

### Sin interior, sin side panel, sin 3D

- NO hay "entrar en una ciudad". Toda la info cabe en la tarjeta expandida.
- NO hay side panel (el contenido se ve in-place).
- NO hay drag-to-rearrange.
- NO hay edit mode.
- NO hay Esc encadenado.

### Pestañas del header

- "Mapa" (nueva 2D) — sigue siendo la pestaña por defecto al loguearse.
- "Proyectos" — pestaña existente sin cambios.
- "Monitorización" — sin cambios.
- "Linear" — sin cambios.

### Caveats F7

- Visualización plana, sin sensación 3D ni espacial. La idea de "mapa" se traduce a "grid temático con regiones por cliente".
- Las **conexiones manuales** (campo `connections` del `.panel.json`) NO se renderizan en F7 (no tienen sentido sin un layout espacial). El campo se mantiene en disco por backwards-compat pero la UI no lo muestra. Si quieres recuperar relaciones visualmente, F8+ puede añadir un diagrama plano simple.
- Los **servicios alojados** muestran su estado mock (igual que F4-F6 hasta que F8+ implemente monitor real por kind). En F7 solo el VPS host tiene status real.

## Sección 2 — Archivos a borrar / crear / modificar

### Borrar

- `frontend/map3d.js` (1668 líneas, todo Three.js).
- `frontend/map3d.css` (363 líneas, estilos 3D).
- `frontend/vendor/three.module.js` (~53000 líneas, lib Three.js self-hosted).
- `frontend/vendor/CSS2DRenderer.js` (~215 líneas, addon).
- `frontend/vendor/` (carpeta vacía tras borrar lo anterior — se elimina también).

### Crear

- `frontend/map2d.js` (~+250 líneas: load /api/world + /api/projects/health, render grid HTML, expand/collapse, polling 30s, refresh button).
- `frontend/map2d.css` (~+150 líneas: estilos de cards, status, chips, grid responsive, animaciones simples de expand).

### Modificar

- `frontend/index.html`:
  - **Quitar** el `<script type="importmap">` con Three.js.
  - **Quitar** el `<link rel="stylesheet" href="/static/map3d.css">`.
  - **Reemplazar** el bloque `<div id="map-home">...</div>` (que tenía `#mapCanvasWrap`, `#mapHud`, `#mapTooltip`, `#mapSidePanel`, `#mapEmptyState`, modales 3D) por uno mucho más simple:
    ```html
    <div id="map-home" class="hidden">
      <header class="map-toolbar">
        <h2>Mapa de infraestructura</h2>
        <button id="mapRefreshBtn" class="btn">↻ refrescar</button>
      </header>
      <div id="map-grid"></div>
      <div id="map-empty" class="hidden">
        <div class="empty-card">
          <h2>Aún no tienes VPSs</h2>
          <p>Crea una desde Proyectos → Mapa.</p>
          <button id="mapEmptyCreate" class="btn primary">Ir a Proyectos</button>
        </div>
      </div>
    </div>
    <link rel="stylesheet" href="/static/map2d.css">
    ```
- `frontend/app.js`:
  - **Reemplazar** `mapEnter()` (que hacía lazy `import('/static/map3d.js')`) por una llamada simple a `initMap2D()` (definida en `map2d.js` cargado como script global).
  - **Quitar** la línea `import('/static/map3d.js')`.
  - **Añadir** `<script src="/static/map2d.js">` al final de `frontend/index.html` (antes del cierre de body, antes de `app.js`).
- `backend/server.py`:
  - **Completar** lo que F6 dejó WIP: helpers `check_vps_health`, `health_poll_loop`, handler `_projects_health`, wirear `/api/projects/health` en `do_GET`, arrancar daemon en `main()`. (El primer bloque, la validación cruzada de `on_host`/`satellites_of` v4, ya está hecho en disco; falta el resto.)

### Plan F1 (formulario): no se toca

- La sub-pestaña Mapa dentro de un proyecto (el formulario con servicios + conexiones + token Linear) sigue funcionando exactamente igual.
- Como bonus opcional en F7: añadir el selector "Alojado en VPS" en el modal de servicio (la mejora que F6 también tenía planeada). Si se prefiere hacerlo en otra fase, se difiere.

## Sección 3 — Backend: completar el polling F6 (sin frontend 3D)

El worker F6 dejó en disco:
- ✅ `validate_meta_payload` con validación cruzada de `on_host`/`satellites_of` (bumpea a `version: 4`).
- ❌ NO terminó: helpers HEALTH_CACHE, check_vps_health, health_poll_loop, handler _projects_health, wiring, arranque del daemon.

F7 completa exactamente lo que F6 había planeado en sus Tasks 2 (definición tal cual el plan de F6 sección "Task 2"):

- Constantes: `HEALTH_CACHE`, `HEALTH_LOCK`, `HEALTH_POLL_INTERVAL = 30`, `HEALTH_TIMEOUT = 15`.
- `check_vps_health(vps_service)` reusa `ssh_run` + `build_collector` + `parse_report` ya existentes.
- `health_poll_loop()` daemon thread itera `PROJECTS`, chequea VPSs, actualiza `HEALTH_CACHE`.
- Handler `_projects_health(c, p)` devuelve cache filtrado por proyecto.
- Wirear `/api/projects/health` en `do_GET` (bloque autenticado existente).
- Arrancar daemon al final de `main()`.

Sin cambios respecto al plan F6 Task 2.

## Sección 4 — Frontend 2D: detalle de componentes

### `frontend/map2d.js` — funciones principales

```javascript
// Estado
let mapData = null;            // último {clients: [...]} de /api/world
let healthCache = new Map();   // vpsId → {status, ts, metrics, error}
let pollTimer = null;
let expandedVpsIds = new Set(); // VPSs con tarjeta expandida (persiste entre re-renders)

// API pública (llamada desde app.js cuando setSection("map"))
function initMap2D() {
  loadAndRender();
  startPolling();
}

async function loadAndRender() {
  try {
    const r = await fetch("/api/world");
    if (!r.ok) throw new Error("HTTP " + r.status);
    mapData = await r.json();
    await fetchAllHealth();
    renderGrid();
  } catch (e) {
    console.error("loadAndRender:", e);
  }
}

async function fetchAllHealth() {
  // Por cada proyecto, fetch /api/projects/health
  const seen = new Set();
  for (const cli of mapData.clients || []) {
    for (const proj of cli.projects || []) {
      const key = cli.name + "/" + proj.name;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const r = await fetch(`/api/projects/health?client=${encodeURIComponent(cli.name)}&project=${encodeURIComponent(proj.name)}`);
        if (!r.ok) continue;
        const data = await r.json();
        for (const [vpsId, entry] of Object.entries(data)) healthCache.set(vpsId, entry);
      } catch (e) { /* ignore */ }
    }
  }
}

function renderGrid() {
  const grid = document.getElementById("map-grid");
  const empty = document.getElementById("map-empty");
  if (!grid) return;

  const allVps = collectAllVps();
  if (allVps.length === 0) {
    grid.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Agrupar VPSs por cliente
  const byClient = new Map();
  for (const item of allVps) {
    if (!byClient.has(item.client)) byClient.set(item.client, []);
    byClient.get(item.client).push(item);
  }

  let html = "";
  for (const [client, items] of byClient) {
    html += `<section class="map-client"><h2>Cliente: ${esc(client)}</h2><div class="vps-grid">`;
    for (const item of items) {
      html += renderVpsCard(item);
    }
    html += `</div></section>`;
  }
  grid.innerHTML = html;
  bindCardHandlers();
}

function collectAllVps() {
  // Devuelve [{client, project, vps, hostedServices, satellites}]
  const out = [];
  for (const cli of mapData.clients || []) {
    for (const proj of cli.projects || []) {
      const services = (proj.meta && proj.meta.services) || [];
      const vpsList = services.filter(s => s.kind === "vps");
      for (const vps of vpsList) {
        const hosted = services.filter(s => s.config && s.config.on_host === vps.id);
        const satellites = services.filter(s => s.config && s.config.satellites_of === vps.id);
        out.push({ client: cli.name, project: proj.name, vps, hostedServices: hosted, satellites });
      }
    }
  }
  return out;
}

function renderVpsCard(item) {
  const { client, project, vps, hostedServices, satellites } = item;
  const health = healthCache.get(vps.id) || { status: "down", error: "sin datos" };
  const statusIcon = { ok: "🟢", warn: "⚠️", down: "⛔" }[health.status] || "⛔";
  const metrics = health.metrics;
  const metricsLine = metrics
    ? `CPU ${Math.round(metrics.cpu_pct)}% · RAM ${Math.round(metrics.ram_pct)}% · Disk ${Math.round(metrics.disk_pct_max)}%`
    : `<span class="muted">${esc(health.error || "sin datos")}</span>`;
  const expanded = expandedVpsIds.has(vps.id);
  const host = (vps.config && vps.config.host) || "(sin host)";
  return `
  <article class="vps-card vps-status-${health.status}${expanded ? " expanded" : ""}" data-vps-id="${esc(vps.id)}">
    <header class="vps-card-header">
      <span class="status-icon">${statusIcon}</span>
      <h3>${esc(vps.name)}</h3>
      <span class="expand-arrow">${expanded ? "▾" : "▸"}</span>
    </header>
    <div class="vps-meta">
      ${esc(host)} <span class="muted">· proj:${esc(project)}</span>
    </div>
    <div class="vps-metrics">${metricsLine}</div>
    <div class="vps-hosted">
      ${hostedServices.length === 0
        ? '<span class="muted">(sin servicios alojados)</span>'
        : hostedServices.map(s => `<span class="svc-chip svc-${esc(s.kind)}">${esc(s.kind)} · ${esc(s.name)}</span>`).join("")}
    </div>
    ${satellites.length > 0
      ? `<div class="vps-satellites">${satellites.map(s => `<span class="sat-chip">${esc(s.kind)} · ${esc(s.name)}</span>`).join("")}</div>`
      : ""}
    ${expanded ? renderVpsExpanded(item, health) : ""}
  </article>`;
}

function renderVpsExpanded(item, health) {
  // Bloques adicionales que se ven al expandir: config completo, hosted en detalle, acciones
  const { vps, hostedServices } = item;
  return `
    <div class="vps-expanded">
      <h4>Config VPS</h4>
      <pre class="vps-config-json">${esc(JSON.stringify(vps.config || {}, null, 2))}</pre>
      <h4>Servicios alojados (${hostedServices.length})</h4>
      ${hostedServices.map(s => `
        <div class="hosted-detail">
          <strong>${esc(s.name)}</strong> <span class="svc-chip svc-${esc(s.kind)}">${esc(s.kind)}</span>
          <pre class="svc-config-json">${esc(JSON.stringify(s.config || {}, null, 2))}</pre>
        </div>`).join("")}
      <div class="vps-actions">
        <button class="btn" data-action="open-editor" data-client="${esc(item.client)}" data-project="${esc(item.project)}">Editar en formulario</button>
      </div>
    </div>`;
}

function bindCardHandlers() {
  document.querySelectorAll(".vps-card-header").forEach(h => {
    h.onclick = () => {
      const card = h.closest(".vps-card");
      const id = card.dataset.vpsId;
      if (expandedVpsIds.has(id)) expandedVpsIds.delete(id);
      else expandedVpsIds.add(id);
      renderGrid();
    };
  });
  document.querySelectorAll('[data-action="open-editor"]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const client = btn.dataset.client;
      const project = btn.dataset.project;
      if (typeof window.setSection === "function") window.setSection("dev");
      // Navegar a ese cliente / proyecto
      if (typeof window.openClient === "function") {
        Promise.resolve(window.openClient(client))
          .then(() => window.openProject ? window.openProject(project) : null)
          .then(() => { if (typeof window.projTabSet === "function") window.projTabSet("map"); });
      }
    };
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await fetchAllHealth();
    renderGrid();
  }, 30000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// Botón refrescar manual
document.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = document.getElementById("mapRefreshBtn");
  if (refreshBtn) refreshBtn.onclick = () => loadAndRender();
  const emptyBtn = document.getElementById("mapEmptyCreate");
  if (emptyBtn) emptyBtn.onclick = () => { if (typeof window.setSection === "function") window.setSection("dev"); };
});

// Exponer initMap2D global para que app.js lo llame en setSection("map")
window.initMap2D = initMap2D;
window.stopMap2DPolling = stopPolling;
```

### `frontend/map2d.css` — estructura

```css
#map-home {
  padding: 16px 24px;
  overflow-y: auto;
  height: calc(100vh - 64px);
}

.map-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.map-toolbar h2 { margin: 0; font-size: 18px; color: var(--text); }

.map-client {
  margin-bottom: 28px;
}

.map-client h2 {
  font-size: 14px;
  color: var(--muted);
  margin: 0 0 10px 0;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}

.vps-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.vps-card {
  background: var(--tool);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: default;
  transition: border-color 200ms;
}

.vps-card.vps-status-ok    { border-left: 4px solid #22c55e; }
.vps-card.vps-status-warn  { border-left: 4px solid #f59e0b; }
.vps-card.vps-status-down  { border-left: 4px solid #ef4444; }

.vps-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.vps-card-header h3 {
  flex: 1;
  margin: 0;
  font-size: 14px;
  color: var(--text);
}

.expand-arrow { color: var(--muted); font-size: 14px; }

.status-icon { font-size: 18px; }

.vps-meta {
  font-size: 12px;
  color: var(--text);
  font-family: monospace;
  margin-top: 6px;
}
.vps-meta .muted { color: var(--muted); }

.vps-metrics {
  font-size: 12px;
  color: var(--text);
  margin: 6px 0;
  font-family: monospace;
}
.vps-metrics .muted { color: var(--muted); font-style: italic; }

.vps-hosted, .vps-satellites {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.svc-chip, .sat-chip {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text);
}

.sat-chip { font-style: italic; opacity: 0.8; }
.svc-chip.svc-vps     { border-color: #8b949e; color: #8b949e; }
.svc-chip.svc-n8n     { border-color: #a371f7; color: #a371f7; }
.svc-chip.svc-docker  { border-color: #2496ed; color: #2496ed; }
.svc-chip.svc-chatwoot{ border-color: #f48120; color: #f48120; }
.svc-chip.svc-postgres{ border-color: #336791; color: #336791; }
.svc-chip.svc-github  { border-color: #e6edf3; color: #e6edf3; }
.svc-chip.svc-linear  { border-color: #5e6ad2; color: #5e6ad2; }

.vps-expanded {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.vps-expanded h4 {
  margin: 8px 0 4px 0;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.vps-config-json, .svc-config-json {
  font-family: monospace;
  font-size: 11px;
  color: var(--text);
  white-space: pre-wrap;
  background: var(--bg);
  padding: 6px 8px;
  border-radius: 4px;
  margin: 4px 0;
}

.hosted-detail {
  margin: 8px 0;
  padding: 6px 0;
  border-bottom: 1px dashed var(--border);
}

.vps-actions {
  margin-top: 12px;
  display: flex;
  gap: 6px;
}

.vps-actions .btn { font-size: 12px; padding: 4px 10px; }
```

## Sección 5 — Verificación + caveats

### Checklist manual (debe pasar antes de declarar F7 completa)

**Backend**
- [ ] Server arranca y log muestra `[health-poll] daemon iniciado`.
- [ ] Tras 30s, `GET /api/projects/health?client=X&project=Y` devuelve status/metrics para cada VPS de ese proyecto.
- [ ] VPS alcanzable por SSH → `status: "ok"`. No alcanzable → `status: "down"`.
- [ ] POST meta con `on_host: "vps-INEXISTENTE"` → 400.
- [ ] Output bumpea a `version: 4`.

**3D borrado**
- [ ] `frontend/map3d.js`, `frontend/map3d.css`, `frontend/vendor/three.module.js`, `frontend/vendor/CSS2DRenderer.js` ya no existen en disco.
- [ ] `index.html` no contiene `<script type="importmap">`, no contiene `<link rel="stylesheet" href="/static/map3d.css">`, no contiene los overlays viejos (#mapCanvasWrap, #mapHud, #mapTooltip, #mapSidePanel, modales del editor 3D).
- [ ] `app.js` no contiene `import('/static/map3d.js')`.
- [ ] Network tab al cargar la pestaña Mapa: cero requests a `three.module.js` o `CSS2DRenderer.js`.

**Vista 2D**
- [ ] Tras login, pestaña Mapa activa, se ve grid de tarjetas (no canvas 3D).
- [ ] Cada cliente con `<h2>Cliente: X</h2>` + grid responsive de tarjetas VPS.
- [ ] Cada tarjeta VPS: icono estado (🟢/⚠️/⛔), nombre, IP+proyecto, métricas, chips de hosted + sat.
- [ ] Click en header de tarjeta → expand. Click otra vez → collapse.
- [ ] Expand muestra config JSON del VPS, hosted services en detalle, botón "Editar en formulario".
- [ ] "Editar en formulario" → navega a Proyectos / cliente / proyecto / sub-pestaña Mapa.
- [ ] Empty state si no hay VPSs.
- [ ] Botón "↻ refrescar" fuerza fetch inmediato.
- [ ] Tras 30s, los iconos status y métricas se actualizan in-place sin desmontar acordeones abiertos.

**No regresiones**
- [ ] Pestaña Proyectos: idéntica (sub-pestaña Mapa con formulario funciona).
- [ ] Pestaña Linear: idéntica.
- [ ] Pestaña Monitorización: idéntica.
- [ ] Login, 2FA, sesiones: sin cambios.

### Caveats explícitos (lo que NO entra en F7)

1. **3D mapa**: eliminado. Si quieres recuperarlo después, revertir desde el commit `36aac96` (F5).
2. **Conexiones manuales** (`connections` del `.panel.json`): siguen en disco pero NO se visualizan en F7. Si quieres un diagrama plano con conexiones, F8+.
3. **Monitor real para n8n/docker/postgres/chatwoot/etc.**: NO. Solo VPS (como F6 ya planeaba). Mock para el resto.
4. **Selector "Alojado en VPS" en formulario F1**: SE INCLUYE en F7 (era el último paso de F6 que faltaba).
5. **Histórico de métricas**: NO. Solo el último valor.
6. **Drag-to-rearrange / Edit Mode / cualquier idea de edición visual**: NO.
7. **WebSocket / SSE**: NO. Polling HTTP cada 30s.
8. **Mobile optimization**: el grid es responsive, pero no se prueba activamente.

### Fases siguientes apuntadas

- **F8**: monitor real para n8n + docker (próximos kinds en self-hosted).
- **F9**: monitor real para postgres + chatwoot.
- **F10**: monitor real para SaaS (github, linear).
- **F11+**: si quieres más visualización (diagrama de conexiones plano, gráficas de métricas), se diseñan ahí.
