// Mapa 2D (Fase 7): vista simple en grid de tarjetas HTML/CSS.
// Reemplaza el mapa 3D Three.js de las fases 3-5. Polling cada 30s al
// backend (/api/projects/health) para iconos de estado y métricas vivas.

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
    if (empty) empty.classList.remove("hidden");
    bindStaticHandlers();
    return;
  }
  if (empty) empty.classList.add("hidden");

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
  bindStaticHandlers();
}

function collectAllVps() {
  // Devuelve [{client, project, vps, hostedServices, satellites}]
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
    ${renderMiniCityMap(vps, hostedServices, satellites, health.status)}
    ${expanded ? renderVpsExpanded(item, health) : ""}
  </article>`;
}

// Mini-mapa SVG: VPS (ayuntamiento) en el centro + carreteras radiales a cada
// servicio alojado. Carreteras colored por estado del VPS. Satélites como
// rectángulos pequeños orbitando con línea punteada.
function renderMiniCityMap(vps, hosted, satellites, status) {
  const W = 240, H = 180, cx = W / 2, cy = H / 2;
  const roadColor = status === "ok"   ? "#22c55e"
                  : status === "warn" ? "#f59e0b"
                  : "#ef4444";
  const kindColors = {
    vps: "#8b949e", n8n: "#a371f7", docker: "#2496ed",
    chatwoot: "#f48120", postgres: "#336791", github: "#e6edf3",
    linear: "#5e6ad2", custom: "#6e7681",
  };
  let svg = `<svg class="vps-mini-map" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;

  // 1) carreteras radiales (DEBAJO de los edificios)
  const N = hosted.length;
  const radius = 62;
  const buildings = [];
  for (let i = 0; i < N; i++) {
    const angle = (2 * Math.PI * i) / N - Math.PI / 2;  // empezar arriba
    const bx = cx + radius * Math.cos(angle);
    const by = cy + radius * Math.sin(angle);
    buildings.push({ svc: hosted[i], x: bx, y: by });
    // Carretera (rect ancho como asfalto)
    svg += `<line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="${roadColor}" stroke-width="3" stroke-linecap="round" opacity="0.85" />`;
    // Línea blanca discontinua encima (marcas viales)
    svg += `<line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="#ffffff" stroke-width="0.8" stroke-dasharray="3,3" opacity="0.6" />`;
  }

  // 2) Satélites: líneas punteadas + rectángulo pequeño orbital
  const satRadius = 96;
  for (let i = 0; i < satellites.length; i++) {
    const angle = (2 * Math.PI * i) / Math.max(satellites.length, 3) + Math.PI / 4;
    const sx = cx + satRadius * Math.cos(angle);
    const sy = cy + satRadius * Math.sin(angle);
    // Clamp dentro del SVG
    const cx2 = Math.max(10, Math.min(W - 10, sx));
    const cy2 = Math.max(10, Math.min(H - 10, sy));
    svg += `<line x1="${cx}" y1="${cy}" x2="${cx2}" y2="${cy2}" stroke="#6e7681" stroke-width="1" stroke-dasharray="2,2" opacity="0.5" />`;
    const color = kindColors[satellites[i].kind] || kindColors.custom;
    svg += `<rect x="${cx2 - 6}" y="${cy2 - 6}" width="12" height="12" rx="2" fill="${color}" opacity="0.7" />`;
  }

  // 3) Ayuntamiento (VPS) — cuadrado grande con cúpula
  const ayuntColor = kindColors.vps;
  svg += `<rect x="${cx - 18}" y="${cy - 18}" width="36" height="36" rx="3" fill="${ayuntColor}" stroke="#fff" stroke-width="1.2" />`;
  // Cúpula
  svg += `<circle cx="${cx}" cy="${cy - 18}" r="6" fill="#d4a017" />`;
  svg += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="#fff" font-size="9" font-weight="600">VPS</text>`;

  // 4) Edificios alojados (DESPUÉS de las carreteras para que se vean encima)
  for (const b of buildings) {
    const color = kindColors[b.svc.kind] || kindColors.custom;
    svg += `<rect x="${b.x - 11}" y="${b.y - 9}" width="22" height="18" rx="2" fill="${color}" stroke="#fff" stroke-width="0.6" />`;
    svg += `<text x="${b.x}" y="${b.y + 3}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">${esc(b.svc.kind)}</text>`;
  }

  // 5) Empty state si no hay alojados ni satélites
  if (N === 0 && satellites.length === 0) {
    svg += `<text x="${cx}" y="${cy + 50}" text-anchor="middle" fill="#6e7681" font-size="9" font-style="italic">sin servicios alojados</text>`;
  }

  svg += `</svg>`;
  return svg;
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

function bindStaticHandlers() {
  // Bind directo (no DOMContentLoaded): map2d.js se carga al final del body,
  // pero initMap2D puede llamarse en cualquier momento y queremos asegurar
  // que el botón "↻ refrescar" y el botón del empty state queden cableados.
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

// Exponer API global para que app.js llame en setSection("map") y tras CRUDs
window.initMap2D = initMap2D;
window.stopMap2DPolling = stopPolling;
window.refreshMap2D = loadAndRender;
