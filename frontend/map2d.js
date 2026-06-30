// Mapa 2D (Fase 7 + 8): grid de tarjetas + drill-in a vista detalle por VPS.
// Polling cada 30s al backend para iconos de estado, métricas y alertas vivas.

// Estado
let mapData = null;
let healthCache = new Map();
let vpsDetailCache = new Map();  // vpsId → response de /api/services/detail (con docker.containers)
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
    // Pre-carga de docker.containers en background (no bloquea el primer render).
    // El siguiente render (grid o detail) ya verá los nodos por contenedor.
    fetchAllVpsDetails();
  } catch (e) {
    console.error("loadAndRender:", e);
  }
}

async function fetchAllVpsDetails() {
  if (!mapData) return;
  const tasks = [];
  for (const cli of mapData.clients || []) {
    for (const proj of cli.projects || []) {
      const services = (proj.meta && proj.meta.services) || [];
      for (const s of services) {
        if (s.kind !== "vps") continue;
        tasks.push(
          fetch(`/api/services/detail?client=${encodeURIComponent(cli.name)}&project=${encodeURIComponent(proj.name)}&service=${encodeURIComponent(s.id)}`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data) vpsDetailCache.set(s.id, data); })
            .catch(() => {})
        );
      }
    }
  }
  await Promise.all(tasks);
  // Re-render para reflejar los containers ya cargados
  if (viewMode === "detail" && detailVpsId) renderVpsDetailView();
  else renderGrid();
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

// Construye la lista unificada de nodos (containers running + declared sin container).
// Se usa tanto en la mini-map preview (vista Mapa) como en la topología grande del detalle.
function buildTopologyNodes(vps, hostedServices) {
  const detail = vpsDetailCache.get(vps.id);
  const docker = detail && detail.data && detail.data.docker;
  const declaredByName = new Map();
  for (const s of hostedServices) {
    if (s.config && s.config.container) declaredByName.set(s.config.container, s);
  }
  const matchedDeclared = new Set();
  const nodes = [];
  if (docker && docker.available !== false) {
    const running = (docker.containers || []).filter(c => (c.state || "").toLowerCase() === "running");
    for (const c of running) {
      const meta = classifyContainer(c.name);
      let declared = declaredByName.get(c.name) || null;
      if (!declared) {
        for (const [n, svc] of declaredByName) {
          if (c.name === n || c.name.startsWith(n + ".")) { declared = svc; break; }
        }
      }
      if (declared) matchedDeclared.add(declared.id);
      const groupDef = CONTAINER_ROLE_GROUPS.find(g => g.key === meta.role)
                    || CONTAINER_ROLE_GROUPS[CONTAINER_ROLE_GROUPS.length - 1];
      nodes.push({ container: c, meta, declared, color: groupDef.color, groupKey: meta.role });
    }
  }
  for (const s of hostedServices) {
    if (matchedDeclared.has(s.id)) continue;
    const declaredContainer = (s.config && s.config.container) || s.name;
    const meta = classifyContainer(declaredContainer);
    const role = _serviceKindToRoleGroup(s.kind, declaredContainer);
    const groupDef = CONTAINER_ROLE_GROUPS.find(g => g.key === role)
                  || CONTAINER_ROLE_GROUPS[CONTAINER_ROLE_GROUPS.length - 1];
    nodes.push({ container: null, meta: { ...meta, role }, declared: s, color: groupDef.color, groupKey: role });
  }
  // Ordena por rol (orden de CONTAINER_ROLE_GROUPS) y luego por env (testing → staging → global)
  const roleIndex = r => {
    const i = CONTAINER_ROLE_GROUPS.findIndex(g => g.key === r);
    return i === -1 ? 999 : i;
  };
  const envOrder = { testing: 0, staging: 1, global: 2 };
  nodes.sort((a, b) => {
    const ra = roleIndex(a.meta.role), rb = roleIndex(b.meta.role);
    if (ra !== rb) return ra - rb;
    const ea = envOrder[a.meta.env] ?? 99, eb = envOrder[b.meta.env] ?? 99;
    if (ea !== eb) return ea - eb;
    return (a.meta.label || "").localeCompare(b.meta.label || "");
  });
  return nodes;
}

// Topología SVG. Si opts.preview, formato pequeño (sin labels, sin click).
// Si !preview, formato grande con labels, click por nodo, etc.
function renderTopologySVG(nodes, vpsService, vpsMetricsLine, vpsStatus, opts = {}) {
  const isPreview = !!opts.preview;
  const roadColor = vpsStatus === "ok" ? "#22c55e" : vpsStatus === "warn" ? "#f59e0b" : "#ef4444";
  const cls = isPreview ? "vps-mini-map" : "detail-topology";
  const N = nodes.length;

  // Tamaño de cada nodo y separación mínima en la circunferencia
  const boxW    = isPreview ? 0   : 110;
  const boxH    = isPreview ? 0   : 50;
  const spacing = isPreview ? 18  : 130;   // distancia mínima entre centros sobre la circunferencia
  const minR    = isPreview ? 70  : 200;

  // Radio dinámico para que los nodos no se solapen: si hay muchos,
  // se aumenta. Y el viewBox crece en consecuencia.
  const radiusNeeded = N > 0
    ? Math.max(minR, (spacing * N) / (2 * Math.PI))
    : minR;
  const margin = isPreview ? 10 : 40;
  const baseW = isPreview ? 260 : 960;
  const baseH = isPreview ? 200 : 560;
  const W = Math.max(baseW, Math.round(radiusNeeded * 2 + boxW + margin * 2));
  const H = Math.max(baseH, Math.round(radiusNeeded * 2 + boxH + margin * 2));
  const cx = W / 2, cy = H / 2;
  const radius = radiusNeeded;

  let svg = `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;

  // Posiciones
  const positions = [];
  for (let i = 0; i < N; i++) {
    const ang = (2 * Math.PI * i) / Math.max(N, 1) - Math.PI / 2;
    positions.push({ x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) });
  }

  // Carreteras (debajo de los nodos)
  for (let i = 0; i < N; i++) {
    const p = positions[i];
    svg += `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="${roadColor}" stroke-width="${isPreview ? 2 : 3}" stroke-linecap="round" opacity="${isPreview ? 0.7 : 0.6}" />`;
    if (!isPreview) {
      svg += `<line x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="#fff" stroke-width="0.6" stroke-dasharray="5,5" opacity="0.4" />`;
    }
  }

  // VPS centro
  const vw = isPreview ? 60 : 170;
  const vh = isPreview ? 38 : 90;
  const vpsClick = isPreview ? "" : `data-action="open-svc" data-service-id="${esc(vpsService.id)}" style="cursor:pointer"`;
  svg += `<g class="topo-vps" ${vpsClick}>
    <rect x="${(cx - vw/2).toFixed(1)}" y="${(cy - vh/2).toFixed(1)}" width="${vw}" height="${vh}" rx="${isPreview ? 4 : 8}" fill="#8b949e" stroke="#fff" stroke-width="${isPreview ? 1 : 2}" />
    <circle cx="${cx}" cy="${(cy - vh/2).toFixed(1)}" r="${isPreview ? 5 : 12}" fill="#d4a017" />
    <text x="${cx}" y="${(cy - (isPreview ? 4 : 12)).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="${isPreview ? 9 : 13}" font-weight="700" letter-spacing="1">VPS</text>
    ${!isPreview ? `<text x="${cx}" y="${cy + 8}" text-anchor="middle" fill="#fff" font-size="11" font-weight="600">${esc((vpsService.name||"").substring(0, 20))}</text>
      <text x="${cx}" y="${cy + 26}" text-anchor="middle" fill="#fff" font-size="10" opacity="0.85" font-family="monospace">${esc((vpsMetricsLine||"").substring(0, 28))}</text>` : ''}
  </g>`;

  // Nodos de contenedor
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    const p = positions[i];
    if (isPreview) {
      // Solo un punto pequeño coloreado
      svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="${n.color}" stroke="#fff" stroke-width="0.8" opacity="0.95" />`;
    } else {
      const title = String(n.declared ? n.declared.name : n.meta.label) || "?";
      const sub = String(n.declared ? n.declared.kind : "container");
      const envTxt = String(n.meta.env || "");
      const showEnv = envTxt && envTxt !== "global";
      const dataAttr = n.declared
        ? `data-action="open-svc" data-service-id="${esc(n.declared.id)}"`
        : `data-action="open-container" data-container-name="${esc(n.container.name)}"`;
      svg += `<g class="topo-node" ${dataAttr} style="cursor:pointer">
        <rect x="${(p.x - boxW/2).toFixed(1)}" y="${(p.y - boxH/2).toFixed(1)}" width="${boxW}" height="${boxH}" rx="6"
              fill="${n.color}" stroke="#fff" stroke-width="1.5" opacity="0.96" />
        ${showEnv ? `<text x="${p.x.toFixed(1)}" y="${(p.y - 12).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="9" opacity="0.85" font-weight="600">${esc(envTxt)}</text>` : ""}
        <text x="${p.x.toFixed(1)}" y="${(p.y + 2).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">${esc(title.substring(0, 14))}</text>
        <text x="${p.x.toFixed(1)}" y="${(p.y + 15).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="9" opacity="0.78">${esc(sub)}</text>
      </g>`;
    }
  }

  if (N === 0) {
    const y = cy + (isPreview ? 56 : 110);
    const msg = isPreview ? "sin servicios" : "sin servicios alojados — añade alguno o instala docker";
    svg += `<text x="${cx}" y="${y}" text-anchor="middle" fill="#6e7681" font-size="${isPreview ? 9 : 12}" font-style="italic">${esc(msg)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

// Mini-map para la vista Mapa: usa la topología en formato preview con datos
// reales de docker (si están cargados en vpsDetailCache).
function renderMiniCityMap(vps, hosted, satellites, status) {
  const nodes = buildTopologyNodes(vps, hosted);
  return renderTopologySVG(nodes, vps, "", status, { preview: true });
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
    </header>`;
  // Fase 8.4 — topología SVG (VPS centro + nodo por sección, conectados con carreteras)
  // + secciones debajo con sub-columnas testing/stg
  html += renderHostedServicesSection(item.hostedServices, item.vps, metricsLine, health.status);

  if (item.satellites.length > 0) {
    html += `<section class="detail-satellites">
      <h4>Satélites SaaS</h4>
      <div class="detail-tiles">
        ${item.satellites.map(s => renderTile(s, true)).join("")}
      </div>
    </section>`;
  }

  html += `<aside id="svc-drawer" class="hidden"></aside>`;
  view.innerHTML = html;
  bindDetailHandlers();
  if (detailServiceId) openServiceDrawer(detailServiceId);
  else if (detailContainerName) openContainerDrawer(detailContainerName);
}

// Grupos por rol semántico. Orden = orden de render.
const CONTAINER_ROLE_GROUPS = [
  { key: "backoffice",  label: "Backoffice",       color: "#a371f7" },
  { key: "frontoffice", label: "Frontoffice",      color: "#6366f1" },
  { key: "chatwoot",    label: "Chatwoot",         color: "#f48120" },
  { key: "n8n",         label: "n8n",              color: "#a371f7" },
  { key: "db",          label: "Base de datos",    color: "#336791" },
  { key: "cache",       label: "Cache / cola",     color: "#dc2626" },
  { key: "proxy",       label: "Proxy / edge",     color: "#0ea5e9" },
  { key: "infra",       label: "Infraestructura",  color: "#8b949e" },
  { key: "other",       label: "Otros",            color: "#6e7681" },
];

// Clasifica un container por nombre → {env, role, label}.
// env: "testing" (= producción para este usuario), "staging", o "global".
function classifyContainer(name) {
  // Quita sufijo de Docker Swarm: foo.1.abc → foo
  const base = name.replace(/\.\d+\.[a-z0-9]+$/i, "");
  let env = "global";
  if (/^testing[_-]/i.test(base) || /[_-]testing(?:[_-]|$)/i.test(base)) env = "testing";
  else if (/^staging[_-]/i.test(base) || /^stg[_-]/i.test(base) || /[_-]staging(?:[_-]|$)/i.test(base) || /[_-]stg(?:[_-]|$)/i.test(base)) env = "staging";
  let role = "other";
  if (/backoffice/i.test(base))                                    role = "backoffice";
  else if (/frontoffice|frontend|^webapp|web[_-]?app/i.test(base)) role = "frontoffice";
  else if (/chatwoot/i.test(base))                                 role = "chatwoot";
  else if (/n8n/i.test(base))                                      role = "n8n";
  else if (/postgres|postgis|^db[_-]|^pg[_-]|database|base[_-]de[_-]datos|mysql|mariadb|mongo/i.test(base)) role = "db";
  else if (/redis|rabbit|kafka|memcache|sidekiq|worker|queue/i.test(base)) role = "cache";
  else if (/traefik|nginx|envoy|caddy|haproxy/i.test(base))        role = "proxy";
  else if (/easypanel|portainer|dokploy|coolify/i.test(base))      role = "infra";
  // Etiqueta limpia: quita el prefijo env si existe
  let label = base;
  if (env === "testing") label = base.replace(/^testing[_-]/i, "");
  else if (env === "staging") label = base.replace(/^staging[_-]|^stg[_-]/i, "");
  return { env, role, label };
}

// Mapea kind de service declarado a un grupo de los CONTAINER_ROLE_GROUPS
function _serviceKindToRoleGroup(kind, name) {
  if (kind === "n8n") return "n8n";
  if (kind === "postgres") return "db";
  if (kind === "chatwoot") return "chatwoot";
  if (kind === "docker") {
    // Heurística por nombre
    const m = classifyContainer(name || "");
    return m.role;
  }
  return "other";
}

function renderHostedServicesSection(hostedServices, vpsService, vpsMetricsLine, vpsStatus) {
  const nodes = buildTopologyNodes(vpsService, hostedServices);

  // Resumen rápido por rol para ayudar al usuario (sin renderizar tarjetas abajo)
  const byRole = new Map();
  for (const n of nodes) {
    const k = n.meta.role;
    if (!byRole.has(k)) byRole.set(k, 0);
    byRole.set(k, byRole.get(k) + 1);
  }
  const roleChips = CONTAINER_ROLE_GROUPS
    .filter(g => byRole.has(g.key))
    .map(g => `<span class="role-chip" style="background:${g.color}1f; color:${g.color}; border:1px solid ${g.color}55">${esc(g.label)} <b>${byRole.get(g.key)}</b></span>`)
    .join("");

  // Estado de la pre-carga
  const detail = vpsDetailCache.get(vpsService.id);
  const docker = detail && detail.data && detail.data.docker;
  let dockerNote = "";
  if (!detail) {
    dockerNote = '<div class="muted topology-note">cargando contenedores…</div>';
  } else if (docker && docker.available === false) {
    dockerNote = '<div class="muted topology-note">⚠ docker no disponible en este host. Mostrando solo servicios declarados.</div>';
  } else if (docker) {
    const all = docker.containers || [];
    const running = all.filter(c => (c.state || "").toLowerCase() === "running").length;
    dockerNote = `<div class="muted topology-note">${running} contenedor${running !== 1 ? "es" : ""} running · ${all.length} totales</div>`;
  }

  return `<section class="detail-services">
    ${renderTopologySVG(nodes, vpsService, vpsMetricsLine, vpsStatus)}
    <div class="topology-legend">${roleChips}</div>
    ${dockerNote}
    <div class="topology-hint">Pincha el VPS o cualquier nodo para ver su detalle</div>
  </section>`;
}

// (renderTopologySVG vieja F8.4 eliminada — la nueva F8.5 está arriba.
//  Era la causa del bug "undefined / undefined nodo": sobrescribía la
//  nueva por hoisting de function declarations.)

// (renderUnifiedTile / renderSectionCard eliminados en F8.5: la vista detalle
//  ya no muestra tarjetas debajo de la topología; toda la info se obtiene
//  haciendo click en los nodos del SVG.)

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
    fetchAllVpsDetails();  // background refresh de contenedores
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
