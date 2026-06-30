// Mapa 2D (Fase 7 + 8): grid de tarjetas + drill-in a vista detalle por VPS.
// Polling cada 30s al backend para iconos de estado, métricas y alertas vivas.

// Estado
let mapData = null;
let healthCache = new Map();
let pollTimer = null;
let expandedVpsIds = new Set();

// Fase 8 — vista detalle
let viewMode = "grid";          // "grid" | "detail"
let detailVpsId = null;         // id del VPS en detalle (null si no)
let detailServiceId = null;     // service id del drawer abierto (declarado)
let detailContainerName = null; // container abierto en drawer (no declarado)
let activeAlerts = [];          // último snapshot de /api/alerts/active
let pgDrawerTab = "monitor";    // tab del drawer postgres
let detailVpsData = null;       // último /api/services/detail del VPS (para docker.containers)

const KIND_COLORS = {
  vps:"#8b949e", n8n:"#a371f7", docker:"#2496ed", chatwoot:"#f48120",
  postgres:"#336791", github:"#e6edf3", linear:"#5e6ad2", custom:"#6e7681"
};
const STATUS_ICONS = { ok: "🟢", warn: "⚠️", down: "⛔" };

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
    await fetchActiveAlerts();
    if (viewMode === "detail" && detailVpsId) renderVpsDetailView();
    else renderGrid();
  } catch (e) {
    console.error("loadAndRender:", e);
  }
}

async function fetchAllHealth() {
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

async function fetchActiveAlerts() {
  try {
    const r = await fetch("/api/alerts/active");
    if (!r.ok) return;
    const data = await r.json();
    activeAlerts = data.alerts || [];
    renderAlertsBanner();
  } catch (e) { /* ignore */ }
}

function renderAlertsBanner() {
  const banner = document.getElementById("alerts-banner");
  if (!banner) return;
  if (activeAlerts.length === 0) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const count = banner.querySelector(".ab-count");
  if (count) count.textContent = activeAlerts.length;
  const list = document.getElementById("alerts-banner-list");
  if (list) {
    list.innerHTML = activeAlerts.map(a => `
      <div class="ab-item">
        <strong>${esc(a.client)}/${esc(a.project)}</strong>
        <span class="muted">${esc(a.service_name || a.service_id)}</span>
        <span class="health-pill health-pill-bad">${esc(a.kind)}</span>
        <span>${esc(a.reason || "")}</span>
      </div>`).join("");
  }
  const toggle = document.getElementById("alerts-banner-toggle");
  if (toggle && !toggle._bound) {
    toggle._bound = true;
    toggle.onclick = () => list.classList.toggle("hidden");
  }
}

function renderGrid() {
  const grid = document.getElementById("map-grid");
  const empty = document.getElementById("map-empty");
  if (!grid) return;

  const allVps = collectAllVps();
  if (allVps.length === 0) {
    grid.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    bindStaticHandlers();
    return;
  }
  if (empty) empty.classList.add("hidden");

  const byClient = new Map();
  for (const item of allVps) {
    if (!byClient.has(item.client)) byClient.set(item.client, []);
    byClient.get(item.client).push(item);
  }

  let html = "";
  for (const [client, items] of byClient) {
    html += `<section class="map-client"><h2>Cliente: ${esc(client)}</h2><div class="vps-grid">`;
    for (const item of items) html += renderVpsCard(item);
    html += `</div></section>`;
  }
  grid.innerHTML = html;
  bindCardHandlers();
  bindStaticHandlers();
}

function collectAllVps() {
  const out = [];
  if (!mapData) return out;
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
  const statusIcon = STATUS_ICONS[health.status] || "⛔";
  const metrics = health.metrics;
  const metricsLine = metrics
    ? `CPU ${Math.round(metrics.cpu_pct)}% · RAM ${Math.round(metrics.ram_pct)}% · Disk ${Math.round(metrics.disk_pct_max)}%`
    : `<span class="muted">${esc(health.error || "sin datos")}</span>`;
  const expanded = expandedVpsIds.has(vps.id);
  const host = (vps.config && vps.config.host) || "(sin host)";

  // Fase 8: badge de alertas firing en esta VPS o services hosteados
  const alertCount = activeAlerts.filter(a =>
    a.service_id === vps.id || hostedServices.some(s => s.id === a.service_id)
  ).length;
  const cardBadge = alertCount > 0
    ? `<span class="alert-badge">${alertCount}</span>` : "";

  return `
  <article class="vps-card vps-status-${health.status}${expanded ? " expanded" : ""}" data-vps-id="${esc(vps.id)}">
    <header class="vps-card-header">
      <span class="status-icon">${statusIcon}</span>
      <h3>${esc(vps.name)}</h3>
      ${cardBadge}
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
    ${renderMiniCityMap(vps, hostedServices, satellites, health.status)}
    <div class="vps-enter-hint" data-action="enter-detail">click para entrar al detalle →</div>
    ${expanded ? renderVpsExpanded(item, health) : ""}
  </article>`;
}

// Mini-mapa SVG: VPS centro + carreteras radiales a servicios. Sin cambios respecto a F7.
function renderMiniCityMap(vps, hosted, satellites, status) {
  const W = 240, H = 180, cx = W / 2, cy = H / 2;
  const roadColor = status === "ok" ? "#22c55e" : status === "warn" ? "#f59e0b" : "#ef4444";
  let svg = `<svg class="vps-mini-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  const N = hosted.length;
  const radius = 62;
  const buildings = [];
  for (let i = 0; i < N; i++) {
    const angle = (2 * Math.PI * i) / N - Math.PI / 2;
    const bx = cx + radius * Math.cos(angle);
    const by = cy + radius * Math.sin(angle);
    buildings.push({ svc: hosted[i], x: bx, y: by });
    svg += `<line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="${roadColor}" stroke-width="3" stroke-linecap="round" opacity="0.85" />`;
    svg += `<line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="#ffffff" stroke-width="0.8" stroke-dasharray="3,3" opacity="0.6" />`;
  }
  const satRadius = 96;
  for (let i = 0; i < satellites.length; i++) {
    const angle = (2 * Math.PI * i) / Math.max(satellites.length, 3) + Math.PI / 4;
    const sx = cx + satRadius * Math.cos(angle);
    const sy = cy + satRadius * Math.sin(angle);
    const cx2 = Math.max(10, Math.min(W - 10, sx));
    const cy2 = Math.max(10, Math.min(H - 10, sy));
    svg += `<line x1="${cx}" y1="${cy}" x2="${cx2}" y2="${cy2}" stroke="#6e7681" stroke-width="1" stroke-dasharray="2,2" opacity="0.5" />`;
    const color = KIND_COLORS[satellites[i].kind] || KIND_COLORS.custom;
    svg += `<rect x="${cx2 - 6}" y="${cy2 - 6}" width="12" height="12" rx="2" fill="${color}" opacity="0.7" />`;
  }
  svg += `<rect x="${cx - 18}" y="${cy - 18}" width="36" height="36" rx="3" fill="${KIND_COLORS.vps}" stroke="#fff" stroke-width="1.2" />`;
  svg += `<circle cx="${cx}" cy="${cy - 18}" r="6" fill="#d4a017" />`;
  svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="9" font-weight="600">VPS</text>`;
  for (const b of buildings) {
    const color = KIND_COLORS[b.svc.kind] || KIND_COLORS.custom;
    svg += `<rect x="${b.x - 11}" y="${b.y - 9}" width="22" height="18" rx="2" fill="${color}" stroke="#fff" stroke-width="0.6" />`;
    svg += `<text x="${b.x}" y="${b.y + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">${esc(b.svc.kind)}</text>`;
  }
  if (N === 0 && satellites.length === 0) {
    svg += `<text x="${cx}" y="${cy + 50}" text-anchor="middle" fill="#6e7681" font-size="9" font-style="italic">sin servicios alojados</text>`;
  }
  svg += `</svg>`;
  return svg;
}

function renderVpsExpanded(item, health) {
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
    h.onclick = (ev) => {
      ev.stopPropagation();
      const card = h.closest(".vps-card");
      const id = card.dataset.vpsId;
      if (expandedVpsIds.has(id)) expandedVpsIds.delete(id);
      else expandedVpsIds.add(id);
      renderGrid();
    };
  });
  // Fase 8: cualquier zona "enter detail" → entra a la vista detalle
  document.querySelectorAll('[data-action="enter-detail"]').forEach(el => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const card = el.closest(".vps-card");
      enterDetail(card.dataset.vpsId);
    };
  });
  // Mini-map y métricas también entran al detalle
  document.querySelectorAll(".vps-card").forEach(card => {
    card.querySelectorAll(".vps-mini-map, .vps-metrics").forEach(el => {
      el.style.cursor = "zoom-in";
      el.onclick = (ev) => {
        ev.stopPropagation();
        enterDetail(card.dataset.vpsId);
      };
    });
  });
  document.querySelectorAll('[data-action="open-editor"]').forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const client = btn.dataset.client;
      const project = btn.dataset.project;
      if (typeof window.setSection === "function") window.setSection("dev");
      if (typeof window.openClient === "function") {
        Promise.resolve(window.openClient(client))
          .then(() => window.openProject ? window.openProject(project) : null)
          .then(() => { if (typeof window.projTabSet === "function") window.projTabSet("map"); });
      }
    };
  });
}

function bindStaticHandlers() {
  const refreshBtn = document.getElementById("mapRefreshBtn");
  if (refreshBtn && !refreshBtn._bound) {
    refreshBtn.onclick = () => loadAndRender();
    refreshBtn._bound = true;
  }
  const emptyBtn = document.getElementById("mapEmptyCreate");
  if (emptyBtn && !emptyBtn._bound) {
    emptyBtn.onclick = () => { if (typeof window.setSection === "function") window.setSection("dev"); };
    emptyBtn._bound = true;
  }
}

// ====================== Vista detalle (Fase 8) ====================== //
function enterDetail(vpsId) {
  viewMode = "detail";
  detailVpsId = vpsId;
  detailServiceId = null;
  detailContainerName = null;
  detailVpsData = null;
  pgDrawerTab = "monitor";
  document.getElementById("map-grid").classList.add("hidden");
  const view = document.getElementById("vps-detail-view");
  if (view) view.classList.remove("hidden");
  // Render inmediato (sin contenedores aún) + fetch VPS detail en paralelo
  renderVpsDetailView();
  fetchVpsDetail();
}

async function fetchVpsDetail() {
  if (!detailVpsId) return;
  const pos = findClientProjectForService(detailVpsId);
  if (!pos) return;
  try {
    const r = await fetch(`/api/services/detail?client=${encodeURIComponent(pos.client)}&project=${encodeURIComponent(pos.project)}&service=${encodeURIComponent(detailVpsId)}`);
    if (!r.ok) return;
    const data = await r.json();
    detailVpsData = data;
    // Re-render para reflejar los contenedores discovered
    if (viewMode === "detail") renderVpsDetailView();
  } catch (e) { /* ignore */ }
}

function exitDetail() {
  viewMode = "grid";
  detailVpsId = null;
  detailServiceId = null;
  detailContainerName = null;
  detailVpsData = null;
  closeServiceDrawer();
  const view = document.getElementById("vps-detail-view");
  if (view) view.classList.add("hidden");
  const grid = document.getElementById("map-grid");
  if (grid) grid.classList.remove("hidden");
  renderGrid();
}

function findVpsItem(vpsId) {
  return collectAllVps().find(i => i.vps.id === vpsId);
}

function findClientProjectForService(serviceId) {
  for (const cli of (mapData?.clients || [])) {
    for (const proj of (cli.projects || [])) {
      const services = (proj.meta && proj.meta.services) || [];
      if (services.some(s => s.id === serviceId)) {
        return { client: cli.name, project: proj.name };
      }
    }
  }
  return null;
}

function renderVpsDetailView() {
  const view = document.getElementById("vps-detail-view");
  if (!view) return;
  const item = findVpsItem(detailVpsId);
  if (!item) { exitDetail(); return; }
  const health = healthCache.get(item.vps.id) || { status: "down", error: "sin datos" };
  const statusIcon = STATUS_ICONS[health.status] || "⛔";
  const metrics = health.metrics;
  const metricsLine = metrics
    ? `CPU ${Math.round(metrics.cpu_pct)}% · RAM ${Math.round(metrics.ram_pct)}% · Disk ${Math.round(metrics.disk_pct_max)}%`
    : (health.error || "sin datos");
  const alertCount = activeAlerts.filter(a =>
    a.service_id === item.vps.id || item.hostedServices.some(s => s.id === a.service_id)
  ).length;
  const alertBadge = alertCount > 0
    ? `<span class="alert-badge">${alertCount} alerta${alertCount>1?'s':''}</span>` : "";

  let html = `
    <header class="detail-header">
      <button class="btn detail-back" id="detail-back-btn">← Volver al mapa</button>
      <h2>VPS: ${esc(item.vps.name)}</h2>
      <span class="status-icon">${statusIcon}</span>
      ${alertBadge}
    </header>
    <section class="detail-center" data-service-id="${esc(item.vps.id)}" data-action="open-svc">
      <div class="detail-center-title">VPS · ayuntamiento</div>
      <div class="detail-center-name">${esc(item.vps.name)}</div>
      <div class="detail-center-metrics">${esc(metricsLine)}</div>
      <div class="detail-center-hint">click para ver detalle completo del sistema →</div>
    </section>
    <section class="detail-tiles">
      ${item.hostedServices.length === 0
        ? '<div class="muted" style="grid-column:1/-1;padding:20px;text-align:center">(sin servicios alojados — añade alguno con config.on_host)</div>'
        : item.hostedServices.map(s => renderTile(s)).join("")}
    </section>`;
  if (item.satellites.length > 0) {
    html += `<section class="detail-satellites">
      <h4>Satélites SaaS</h4>
      <div class="detail-tiles">
        ${item.satellites.map(s => renderTile(s, true)).join("")}
      </div>
    </section>`;
  }

  // Fase 8.1 — contenedores docker descubiertos vía probe_vps
  html += renderDockerContainersSection(item.hostedServices);

  html += `<aside id="svc-drawer" class="hidden"></aside>`;
  view.innerHTML = html;
  bindDetailHandlers();
  if (detailServiceId) openServiceDrawer(detailServiceId);
  else if (detailContainerName) openContainerDrawer(detailContainerName);
}

function renderDockerContainersSection(hostedServices) {
  const docker = (detailVpsData && detailVpsData.data && detailVpsData.data.docker) || null;
  if (!docker) {
    return `<section class="detail-containers">
      <h4>Contenedores Docker</h4>
      <div class="muted" style="padding:12px">Cargando contenedores…</div>
    </section>`;
  }
  if (docker.available === false) {
    return `<section class="detail-containers">
      <h4>Contenedores Docker</h4>
      <div class="muted" style="padding:12px">docker no disponible en este host (o el usuario SSH no tiene acceso)</div>
    </section>`;
  }
  const containers = docker.containers || [];
  if (containers.length === 0) {
    return `<section class="detail-containers">
      <h4>Contenedores Docker (0)</h4>
      <div class="muted" style="padding:12px">no hay contenedores corriendo</div>
    </section>`;
  }
  // Detectar qué contenedores ya están "declarados" como service.config.container
  const declaredByName = new Map();
  for (const s of hostedServices) {
    const cont = s.config && s.config.container;
    if (cont) declaredByName.set(cont, s);
  }
  return `<section class="detail-containers">
    <h4>Contenedores Docker (${containers.length})</h4>
    <div class="detail-tiles">
      ${containers.map(c => renderContainerTile(c, declaredByName)).join("")}
    </div>
  </section>`;
}

function renderContainerTile(c, declaredByName) {
  // Matchear por prefijo: container "n8n.1.abc" matchea declarado "n8n"
  let declared = declaredByName.get(c.name);
  if (!declared) {
    for (const [name, svc] of declaredByName) {
      if (c.name === name || c.name.startsWith(name + ".")) { declared = svc; break; }
    }
  }
  const stateClass = (c.state || "").toLowerCase() === "running" ? "ok" : "bad";
  const stateBadge = `<span class="health-pill health-pill-${stateClass}">${esc(c.state || "?")}</span>`;
  const declaredChip = declared
    ? `<span class="container-declared-chip" title="declarado como ${esc(declared.kind)}/${esc(declared.name)}">declarado</span>`
    : "";
  const metric = (c.cpu || c.mem)
    ? `<div class="tile-role muted">CPU ${esc(c.cpu || "-")} · MEM ${esc(c.mem || "-")}</div>`
    : "";
  return `
    <div class="detail-tile detail-tile-container"
         data-container-name="${esc(c.name)}" data-action="open-container"
         style="border-left:4px solid ${KIND_COLORS.docker}">
      <div class="tile-kind">container ${declaredChip}</div>
      <div class="tile-name">${esc(c.name)}</div>
      <div class="tile-role muted" title="${esc(c.image)}">${esc((c.image||"").substring(0,40))}</div>
      ${metric}
      <div style="margin-top:6px">${stateBadge}</div>
    </div>`;
}

function renderTile(svc, isSatellite = false) {
  const color = KIND_COLORS[svc.kind] || KIND_COLORS.custom;
  const role = (svc.config && svc.config.role) || svc.kind;
  const cont = (svc.config && svc.config.container) || "";
  const tileAlert = activeAlerts.find(a => a.service_id === svc.id);
  const alertMark = tileAlert ? '<span class="tile-alert" title="alerta activa">⚠</span>' : "";
  return `
    <div class="detail-tile ${isSatellite ? 'detail-tile-sat' : ''}"
         data-service-id="${esc(svc.id)}" data-action="open-svc"
         style="border-left:4px solid ${color}">
      <div class="tile-kind">${esc(svc.kind)} ${alertMark}</div>
      <div class="tile-name">${esc(svc.name)}</div>
      <div class="tile-role muted">${esc(role)}${cont ? " · " + esc(cont) : ""}</div>
    </div>`;
}

function bindDetailHandlers() {
  const back = document.getElementById("detail-back-btn");
  if (back) back.onclick = exitDetail;
  document.querySelectorAll('[data-action="open-svc"]').forEach(el => {
    el.onclick = (ev) => { ev.stopPropagation(); openServiceDrawer(el.dataset.serviceId); };
  });
  document.querySelectorAll('[data-action="open-container"]').forEach(el => {
    el.onclick = (ev) => { ev.stopPropagation(); openContainerDrawer(el.dataset.containerName); };
  });
}

async function openContainerDrawer(containerName) {
  detailServiceId = null;
  detailContainerName = containerName;
  const drawer = document.getElementById("svc-drawer");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>Cargando container ${esc(containerName)}…</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    <div class="drawer-loading">Consultando docker logs por SSH…</div>`;
  bindDrawerCloseAgain();
  const pos = findClientProjectForService(detailVpsId);
  if (!pos) {
    drawer.innerHTML = renderDrawerError("no se localizó client/project del VPS host");
    bindDrawerCloseAgain();
    return;
  }
  const url = `/api/services/container?client=${encodeURIComponent(pos.client)}` +
              `&project=${encodeURIComponent(pos.project)}` +
              `&vps=${encodeURIComponent(detailVpsId)}` +
              `&container=${encodeURIComponent(containerName)}`;
  let resp;
  try {
    const r = await fetch(url);
    resp = await r.json();
  } catch (e) {
    drawer.innerHTML = renderDrawerError("fetch error: " + e.message);
    bindDrawerCloseAgain();
    return;
  }
  if (resp.error) {
    drawer.innerHTML = renderDrawerError(resp.error);
    bindDrawerCloseAgain();
    return;
  }
  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>container · ${esc(containerName)}</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    ${renderLogsDrawer(resp.data)}`;
  bindDrawerCloseAgain();
}

// ====================== Drawer del servicio ====================== //
async function openServiceDrawer(serviceId) {
  detailServiceId = serviceId;
  const drawer = document.getElementById("svc-drawer");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>Cargando…</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    <div class="drawer-loading">Consultando VPS por SSH…</div>`;
  bindDrawerCloseAgain();

  const pos = findClientProjectForService(serviceId);
  if (!pos) {
    drawer.innerHTML = renderDrawerError("no se localizó client/project del service");
    bindDrawerCloseAgain();
    return;
  }
  const url = `/api/services/detail?client=${encodeURIComponent(pos.client)}` +
              `&project=${encodeURIComponent(pos.project)}` +
              `&service=${encodeURIComponent(serviceId)}`;
  let resp;
  try {
    const r = await fetch(url);
    resp = await r.json();
  } catch (e) {
    drawer.innerHTML = renderDrawerError("fetch error: " + e.message);
    bindDrawerCloseAgain();
    return;
  }
  if (resp.error) {
    drawer.innerHTML = renderDrawerError(resp.error);
    bindDrawerCloseAgain();
    return;
  }
  const svc = resp.service;
  const kind = svc.kind;
  let body = "";
  if (kind === "vps") body = renderVpsDrawer(resp.data);
  else if (kind === "n8n") body = renderN8nDrawer(resp.data);
  else if (kind === "postgres") body = renderPostgresDrawer(resp.data);
  else if (kind === "chatwoot" || kind === "docker") body = renderLogsDrawer(resp.data);
  else if (kind === "github" || kind === "linear") body = renderSaasDrawer(resp.data);
  else body = `<div class="drawer-section">Sin renderer para kind <code>${esc(kind)}</code></div>`;

  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>${esc(svc.kind)} · ${esc(svc.name)}</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    ${body}`;
  bindDrawerCloseAgain();
  if (kind === "postgres") {
    document.querySelectorAll('[data-pg-tab]').forEach(b => {
      b.onclick = () => { pgDrawerTab = b.dataset.pgTab; openServiceDrawer(detailServiceId); };
    });
  }
}

function bindDrawerCloseAgain() {
  const x = document.getElementById("drawer-close-btn");
  if (x) x.onclick = closeServiceDrawer;
}

function closeServiceDrawer() {
  detailServiceId = null;
  detailContainerName = null;
  const drawer = document.getElementById("svc-drawer");
  if (drawer) {
    drawer.classList.add("hidden");
    drawer.innerHTML = "";
  }
}

function renderDrawerError(msg) {
  return `<div class="drawer-header"><h3>Error</h3>
    <button class="drawer-close" id="drawer-close-btn">✕</button></div>
    <div class="drawer-error">${esc(msg)}</div>`;
}

// =================== Renderers por kind =================== //
function renderVpsDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const sys = d.system || {};
  const mem = sys.mem || {};
  const top = sys.top || [];
  const docker = d.docker || {};
  const containers = docker.containers || [];
  return `
    <section class="drawer-section">
      <h4>Sistema</h4>
      <table class="drawer-table">
        <tr><td>Host</td><td>${esc(sys.hostname || "-")}</td></tr>
        <tr><td>Kernel</td><td>${esc(sys.kernel || "-")}</td></tr>
        <tr><td>CPU</td><td>${sys.cpu_pct ?? "-"}% (${sys.ncpu ?? "?"} cores)</td></tr>
        <tr><td>RAM</td><td>${mem.pct ?? "-"}% (${fmtBytes(mem.used)}/${fmtBytes(mem.total)})</td></tr>
        <tr><td>Uptime</td><td>${fmtDuration(sys.uptime)}</td></tr>
        <tr><td>Load</td><td>${(sys.loadavg||[]).join(" / ")}</td></tr>
      </table>
    </section>
    <section class="drawer-section">
      <h4>Discos</h4>
      <table class="drawer-table">
        <tr><th>Mount</th><th>Uso</th><th>Total</th></tr>
        ${(sys.disk||[]).map(x => `<tr><td>${esc(x.mount)}</td><td>${x.pct}%</td><td>${fmtBytes(x.size)}</td></tr>`).join("")}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Top procesos</h4>
      <table class="drawer-table">
        <tr><th>PID</th><th>Cmd</th><th>CPU</th><th>MEM</th></tr>
        ${top.map(p => `<tr><td>${esc(p.pid)}</td><td>${esc(p.cmd)}</td><td>${esc(p.cpu)}</td><td>${esc(p.mem)}</td></tr>`).join("")}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Docker (${containers.length})</h4>
      ${docker.available === false
        ? '<div class="muted">docker no disponible</div>'
        : `<table class="drawer-table">
            <tr><th>Nombre</th><th>State</th><th>CPU</th><th>MEM</th></tr>
            ${containers.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.state)}</td><td>${esc(c.cpu||"-")}</td><td>${esc(c.mem||"-")}</td></tr>`).join("")}
          </table>`}
    </section>`;
}

function renderN8nDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const health = d.health_ok
    ? '<span class="health-pill health-pill-ok">healthz 200</span>'
    : `<span class="health-pill health-pill-bad">healthz ${esc(d.health || "?")}</span>`;
  const c = d.container || {};
  return `
    <section class="drawer-section">
      <h4>Health</h4>
      ${health}
      ${c.name ? `<div class="muted" style="margin-top:6px">container: ${esc(c.name)} (${esc(c.status||c.state||"?")})</div>` : ""}
    </section>
    <section class="drawer-section">
      <h4>Workflows (${(d.workflows||[]).length})</h4>
      ${(d.workflows||[]).length === 0
        ? '<div class="muted">sin workflows (¿base de datos n8n no encontrada?)</div>'
        : `<table class="drawer-table">
            <tr><th>Nombre</th><th>Active</th><th>Actualizado</th></tr>
            ${d.workflows.map(w => `<tr>
              <td>${esc(w.name)}</td>
              <td>${w.active ? '<span class="health-pill health-pill-ok">on</span>' : '<span class="muted">off</span>'}</td>
              <td>${esc(w.updated)}</td>
            </tr>`).join("")}
          </table>`}
    </section>
    <section class="drawer-section">
      <h4>Ejecuciones recientes (${(d.recent||[]).length})</h4>
      <table class="drawer-table">
        <tr><th>Workflow</th><th>Status</th><th>Cuándo</th><th>Modo</th></tr>
        ${(d.recent||[]).map(e => {
          const pill = e.status === "success"
            ? '<span class="health-pill health-pill-ok">success</span>'
            : e.status === "error"
              ? '<span class="health-pill health-pill-bad">error</span>'
              : esc(e.status);
          return `<tr><td>${esc(e.workflow)}</td><td>${pill}</td><td>${esc(e.started)}</td><td>${esc(e.mode)}</td></tr>`;
        }).join("")}
      </table>
    </section>`;
}

function renderPostgresDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const tabs = `
    <div class="drawer-tabs">
      <button class="drawer-tab ${pgDrawerTab==='monitor'?'active':''}" data-pg-tab="monitor">Monitor</button>
      <button class="drawer-tab ${pgDrawerTab==='schema'?'active':''}" data-pg-tab="schema">Schema</button>
    </div>`;
  const body = pgDrawerTab === "monitor"
    ? renderPgMonitor(d.stats || {})
    : renderPgSchema(d.schema || {});
  return tabs + body;
}

function renderPgMonitor(s) {
  const ready = s.ready
    ? '<span class="health-pill health-pill-ok">accepting</span>'
    : `<span class="health-pill health-pill-bad">${esc(s.isready||"down")}</span>`;
  return `
    <section class="drawer-section">
      <h4>Estado</h4>
      ${ready}
      <table class="drawer-table" style="margin-top:6px">
        <tr><td>Tamaño</td><td>${esc(s.size||"-")}</td></tr>
        <tr><td>Conexiones</td><td>${s.conns ?? "-"}</td></tr>
        <tr><td>Versión</td><td>${esc(s.version||"-")}</td></tr>
      </table>
    </section>
    <section class="drawer-section">
      <h4>Queries activas (${(s.active_queries||[]).length})</h4>
      ${(s.active_queries||[]).length === 0
        ? '<div class="muted">ninguna</div>'
        : `<table class="drawer-table">
            <tr><th>PID</th><th>State</th><th>Desde</th><th>Query</th></tr>
            ${s.active_queries.map(q => `<tr><td>${esc(q.pid)}</td><td>${esc(q.state)}</td><td>${esc(q.since)}</td><td>${esc(q.query)}</td></tr>`).join("")}
          </table>`}
    </section>`;
}

function renderPgSchema(sch) {
  const tables = sch.tables || [];
  const fks = sch.fks || [];
  const trunc = sch.truncated
    ? '<div class="muted">⚠ schema truncado (cap aplicado)</div>' : "";
  return `
    <section class="drawer-section">
      <h4>Tablas (${tables.length}) · FKs (${fks.length})</h4>
      ${trunc}
      ${renderFkGraph(tables, fks)}
      <div style="margin-top:12px">
        ${tables.map(t => `
          <details>
            <summary>${esc(t.schema)}.${esc(t.name)} (${(t.columns||[]).length} cols)</summary>
            <table class="drawer-table">
              <tr><th>Columna</th><th>Tipo</th><th>Null</th></tr>
              ${(t.columns||[]).map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${c.nullable?"YES":"NO"}</td></tr>`).join("")}
            </table>
          </details>`).join("")}
      </div>
    </section>`;
}

function renderFkGraph(tables, fks) {
  if (tables.length === 0) return "";
  const degree = {};
  fks.forEach(fk => {
    const a = fk.from_schema+"."+fk.from_table;
    const b = fk.to_schema+"."+fk.to_table;
    degree[a] = (degree[a]||0) + 1;
    degree[b] = (degree[b]||0) + 1;
  });
  const top = tables
    .map(t => ({k: t.schema+"."+t.name, t}))
    .sort((a,b) => (degree[b.k]||0) - (degree[a.k]||0))
    .slice(0, 30);
  if (top.length === 0) return "";
  const W = 460, H = 280, cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 24;
  const pos = {};
  top.forEach((it, i) => {
    const a = (2 * Math.PI * i) / top.length - Math.PI/2;
    pos[it.k] = { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) };
  });
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:${H}px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:4px">`;
  fks.forEach(fk => {
    const a = pos[fk.from_schema+"."+fk.from_table];
    const b = pos[fk.to_schema+"."+fk.to_table];
    if (a && b) {
      svg += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#5e6ad2" stroke-width="0.8" opacity="0.5" />`;
    }
  });
  top.forEach(it => {
    const p = pos[it.k];
    svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#a371f7" />`;
    svg += `<text x="${p.x.toFixed(1)}" y="${(p.y-7).toFixed(1)}" text-anchor="middle" fill="#c9d1d9" font-size="9">${esc(it.t.name)}</text>`;
  });
  svg += `</svg>`;
  return svg;
}

function renderLogsDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const c = d.container || {};
  const stateClass = (c.state||"").toLowerCase() === "running" ? "ok" : "bad";
  const stateBadge = `<span class="health-pill health-pill-${stateClass}">${esc(c.state||"?")}</span>`;
  const health = d.health_status
    ? `<span class="health-pill health-pill-${d.health_status.startsWith("2")?"ok":"bad"}">HTTP ${esc(d.health_status)}</span>`
    : "";
  return `
    <section class="drawer-section">
      <h4>Container</h4>
      ${stateBadge} ${health}
      <table class="drawer-table" style="margin-top:6px">
        <tr><td>Nombre</td><td>${esc(c.name||"-")}</td></tr>
        <tr><td>Imagen</td><td>${esc(c.image||"-")}</td></tr>
        <tr><td>Status</td><td>${esc(c.status||"-")}</td></tr>
        ${d.health_url ? `<tr><td>Health URL</td><td><code>${esc(d.health_url)}</code></td></tr>` : ""}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Logs (últimas ${d.logs_lines||0} líneas)</h4>
      <div class="drawer-logs">${esc(d.logs||"(sin logs)")}</div>
    </section>`;
}

function renderSaasDrawer(d) {
  return `
    <section class="drawer-section">
      <h4>SaaS</h4>
      <div class="muted">Este servicio es SaaS — no se monitoriza por SSH.</div>
      <pre class="drawer-logs">${esc(JSON.stringify((d && d.config) || {}, null, 2))}</pre>
    </section>`;
}

// ====================== Util ====================== //
function fmtBytes(n) {
  if (!n) return "-";
  const k = 1024;
  if (n < k) return n + " B";
  if (n < k*k) return (n/k).toFixed(1) + " KB";
  if (n < k*k*k) return (n/k/k).toFixed(1) + " MB";
  return (n/k/k/k).toFixed(2) + " GB";
}
function fmtDuration(s) {
  if (!s) return "-";
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return `${d}d ${h}h ${m}m`;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await fetchAllHealth();
    await fetchActiveAlerts();
    if (viewMode === "detail") renderVpsDetailView();
    else renderGrid();
  }, 30000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}

// Exponer API global para que app.js llame en setSection("map") y tras CRUDs
window.initMap2D = initMap2D;
window.stopMap2DPolling = stopPolling;
window.refreshMap2D = loadAndRender;
