const $ = s => document.querySelector(s);
const log = $("#log");
function esc(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function scroll() { log.scrollTop = log.scrollHeight; }

// --------------------------------------------------------------------------- //
// Estado: Cliente -> Proyecto -> Repos. Cada repo tiene varias conversaciones.
// --------------------------------------------------------------------------- //
let clients = [], projectsList = [], repos = [];
let selClient = null, selProject = null, current = null;  // current = repo
const pstate = {};   // key "cliente/proyecto/repo" -> {convos, activeId, busy}

const repoKey = name => `${selClient}/${selProject}/${name}`;
const curKey = () => current ? repoKey(current) : null;

function newConvoObj() {
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
           title: "Conversación", sessionId: null, entries: [] };
}
function st(key) {
  if (!pstate[key]) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem("convos:" + key) || "[]"); } catch (_) {}
    let convos = saved.map(c => ({ id: c.id, title: c.title || "Conversación",
                                   sessionId: c.sessionId || null, entries: [] }));
    if (!convos.length) convos = [newConvoObj()];
    let activeId = localStorage.getItem("active:" + key);
    if (!convos.find(c => c.id === activeId)) activeId = convos[0].id;
    pstate[key] = { convos, activeId, busy: false };
  }
  return pstate[key];
}
function activeConvo(key) { const s = st(key); return s.convos.find(c => c.id === s.activeId) || s.convos[0]; }
function saveConvos(key) {
  const s = st(key);
  localStorage.setItem("convos:" + key, JSON.stringify(s.convos.map(c => ({ id: c.id, title: c.title, sessionId: c.sessionId }))));
  localStorage.setItem("active:" + key, s.activeId);
}

// --------------------------------------------------------------------------- //
// Login
// --------------------------------------------------------------------------- //
let totpOn = false;
async function checkAuth() {
  const r = await fetch("/api/whoami");
  const j = await r.json();
  totpOn = !!j.totp;
  if (totpOn) $("#code").classList.remove("hidden");
  if (j.authed) showApp();
}
async function doLogin() {
  const r = await fetch("/api/login", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({password: $("#pw").value, code: $("#code").value})
  });
  if (r.ok) { showApp(); return; }
  let msg = "Credenciales incorrectas";
  try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) {}
  $("#loginErr").textContent = msg;
}
async function showApp() {
  $("#login").classList.add("hidden");
  $("#app-header").classList.remove("hidden");
  setSection("map");
  await restore();
}
async function restore() {
  await loadClients();
  const c = localStorage.getItem("lastClient");
  if (c && clients.find(x => x.name === c)) {
    await openClient(c);
    const p = localStorage.getItem("lastProject");
    if (p && projectsList.find(x => x.name === p)) {
      await openProject(p);
      const r = localStorage.getItem("lastRepo");
      if (r && repos.find(x => x.name === r)) selectRepo(r);
    }
  }
}
$("#loginBtn").onclick = doLogin;
$("#pw").addEventListener("keydown", e => { if (e.key === "Enter") { if (totpOn) $("#code").focus(); else doLogin(); } });
$("#code").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

// --------------------------------------------------------------------------- //
// Secciones y navegación de desarrollo (clientes / proyectos / repos)
// --------------------------------------------------------------------------- //
let devScreen = "clients";
function showDev(screen) {
  devScreen = screen;
  $("#clients-view").classList.toggle("hidden", screen !== "clients");
  $("#projects-view").classList.toggle("hidden", screen !== "projects");
  $("#main-row").classList.toggle("hidden", screen !== "repos");
}
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
$("#tabMap").onclick = () => setSection("map");
$("#tabDev").onclick = () => setSection("dev");
$("#tabMon").onclick = () => setSection("mon");
$("#tabLinear").onclick = () => setSection("linear");

// ---- clientes ----
async function loadClients() {
  try { clients = (await (await fetch("/api/clients")).json()).clients || []; }
  catch (e) { clients = []; }
  renderClientGrid();
}
function renderClientGrid() {
  const g = $("#clientGrid"); g.innerHTML = "";
  if (!clients.length) { g.innerHTML = '<div class="grid-empty">No hay clientes. Crea el primero con "+ Nuevo cliente".</div>'; return; }
  for (const c of clients) {
    const d = document.createElement("div"); d.className = "card-item";
    d.innerHTML = `<h3>${esc(c.name)}</h3><div class="ci-meta">${c.projects} proyecto(s)</div>`;
    const ed = document.createElement("button"); ed.className = "ci-edit"; ed.textContent = "✎"; ed.title = "Renombrar";
    ed.onclick = ev => { ev.stopPropagation(); renameClient(c.name); };
    const del = document.createElement("button"); del.className = "ci-del"; del.textContent = "×";
    del.onclick = ev => { ev.stopPropagation(); delClient(c.name); };
    d.appendChild(ed); d.appendChild(del);
    d.onclick = () => openClient(c.name);
    g.appendChild(d);
  }
}
$("#newClientBtn").onclick = async () => {
  const name = (prompt("Nombre del cliente:") || "").trim();
  if (!name) return;
  const r = await fetch("/api/clients/create", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name}) });
  if (r.ok) {
    loadClients();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  }
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo crear"); }
};
async function delClient(name) {
  if (!confirm(`¿Borrar el cliente "${name}" y TODOS sus proyectos y repos?`)) return;
  const r = await fetch("/api/clients/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name}) });
  if (r.ok) {
    loadClients();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  } else alert("No se pudo borrar");
}
async function renameClient(name) {
  const nn = (prompt("Nuevo nombre del cliente:", name) || "").trim();
  if (!nn || nn === name) return;
  const r = await fetch("/api/clients/rename", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name, new_name: nn}) });
  if (r.ok) {
    if (selClient === name) { selClient = nn; localStorage.setItem("lastClient", nn); }
    loadClients();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  }
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo renombrar"); }
}
async function openClient(name) {
  selClient = name; localStorage.setItem("lastClient", name);
  $("#projectsTitle").textContent = "Proyectos · " + name;
  await loadProjects();
  showDev("projects");
}
$("#backToClients").onclick = () => { loadClients(); showDev("clients"); };

// ---- proyectos ----
async function loadProjects() {
  try { projectsList = (await (await fetch("/api/projects?client=" + encodeURIComponent(selClient))).json()).projects || []; }
  catch (e) { projectsList = []; }
  renderProjectGrid();
}
function renderProjectGrid() {
  const g = $("#projectGrid"); g.innerHTML = "";
  if (!projectsList.length) { g.innerHTML = '<div class="grid-empty">No hay proyectos. Crea uno con "+ Nuevo proyecto".</div>'; return; }
  for (const p of projectsList) {
    const d = document.createElement("div"); d.className = "card-item";
    d.innerHTML = `<h3>${esc(p.name)}</h3><div class="ci-meta">${p.repos} repo(s)</div>`;
    const ed = document.createElement("button"); ed.className = "ci-edit"; ed.textContent = "✎"; ed.title = "Renombrar";
    ed.onclick = ev => { ev.stopPropagation(); renameProject(p.name); };
    const del = document.createElement("button"); del.className = "ci-del"; del.textContent = "×";
    del.onclick = ev => { ev.stopPropagation(); delProject(p.name); };
    d.appendChild(ed); d.appendChild(del);
    d.onclick = () => openProject(p.name);
    g.appendChild(d);
  }
}
$("#newProjectBtn").onclick = async () => {
  const name = (prompt("Nombre del proyecto:") || "").trim();
  if (!name) return;
  const r = await fetch("/api/projects/create", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, name}) });
  if (r.ok) {
    loadProjects();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  }
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo crear"); }
};
async function delProject(name) {
  if (!confirm(`¿Borrar el proyecto "${name}" y todos sus repos?`)) return;
  const r = await fetch("/api/projects/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, name}) });
  if (r.ok) {
    loadProjects();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  } else alert("No se pudo borrar");
}
async function renameProject(name) {
  const nn = (prompt("Nuevo nombre del proyecto:", name) || "").trim();
  if (!nn || nn === name) return;
  const r = await fetch("/api/projects/rename", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, name, new_name: nn}) });
  if (r.ok) {
    if (selProject === name) { selProject = nn; localStorage.setItem("lastProject", nn); }
    loadProjects();
    if (typeof window.refreshMap2D === "function") window.refreshMap2D();
  }
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo renombrar"); }
}
async function openProject(name) {
  selProject = name; localStorage.setItem("lastProject", name);
  current = null;
  await loadRepos();
  showDev("repos");
  enterReposView();
}
function setCrumb() {
  $("#crumb").innerHTML =
    `<a data-nav="clients">Clientes</a><span class="sep">›</span>` +
    `<a data-nav="projects">${esc(selClient)}</a><span class="sep">›</span>` +
    `<span class="cur">${esc(selProject)}</span>`;
}
$("#crumb").addEventListener("click", e => {
  const nav = e.target.dataset.nav;
  if (nav === "clients") { loadClients(); showDev("clients"); }
  else if (nav === "projects") { current = null; loadProjects(); showDev("projects"); }
});

// --------------------------------------------------------------------------- //
// Editor "Mapa" (Fase 1): formulario para servicios + conexiones + token Linear.
// El 3D llegará en Fase 3; aquí solo capturamos y persistimos la metadata.
// --------------------------------------------------------------------------- //
const SVC_KINDS = ["vps", "n8n", "docker", "chatwoot", "postgres", "github", "linear", "custom"];
let mapState = { services: [], connections: [], linear_status: { has_project_token: false, has_global_fallback: false } };
let mapLoaded = false;
let mapDirtyBaseline = "";  // JSON.stringify del state cargado desde server

function projTabSet(view) {
  document.querySelectorAll(".proj-tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#repos-area").classList.toggle("hidden", view !== "repos");
  $("#map-area").classList.toggle("hidden", view !== "map");
  $("#alerts-area").classList.toggle("hidden", view !== "alerts");
  if (view === "map") enterMapTab();
  if (view === "alerts") enterAlertsTab();
}
window.projTabSet = projTabSet;

document.querySelectorAll(".proj-tab").forEach(b => b.onclick = () => projTabSet(b.dataset.view));

function mapKey() { return `${selClient}/${selProject}`; }

async function loadMeta(client, project) {
  try {
    const r = await fetch(`/api/projects/meta?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    const data = await r.json();
    mapState = {
      services: data.services || [],
      connections: data.connections || [],
      linear_status: data.linear_status || { has_project_token: false, has_global_fallback: false },
    };
    mapDirtyBaseline = JSON.stringify({ services: mapState.services, connections: mapState.connections });
    mapLoaded = true;
    renderMap();
    updateDirty();
  } catch (e) {
    mapState = { services: [], connections: [], linear_status: { has_project_token: false, has_global_fallback: false } };
    mapDirtyBaseline = "";
    mapLoaded = false;
    renderMap();
    alert("No se pudo cargar la metadata: " + e.message);
  }
}

async function enterMapTab() {
  if (!selClient || !selProject) return;
  await loadMeta(selClient, selProject);
}

// =============== Fase 8: tab Alertas ================ //
async function enterAlertsTab() {
  if (!selClient || !selProject) return;
  if (mapState.services.length === 0) {
    await loadMeta(selClient, selProject).catch(() => {});
  }
  await renderAlertsTab();
}

const ALERT_KINDS_UI = [
  { value: "cpu_above",            label: "CPU >",                  needsT: true },
  { value: "ram_above",            label: "RAM >",                  needsT: true },
  { value: "disk_above",           label: "Disk >",                 needsT: true },
  { value: "container_down",       label: "Container caído",        needsT: false },
  { value: "n8n_workflow_failed",  label: "Workflow n8n falló",     needsT: false },
  { value: "health_url_not_2xx",   label: "Health URL no 2xx",      needsT: false },
];

async function renderAlertsTab() {
  const container = $("#alerts-panel-content");
  container.innerHTML = `<div class="muted" style="padding:20px">Cargando alertas…</div>`;
  let data;
  try {
    const r = await fetch(`/api/projects/alerts?client=${encodeURIComponent(selClient)}&project=${encodeURIComponent(selProject)}`);
    data = await r.json();
  } catch (e) {
    container.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    return;
  }
  const services = mapState.services || [];
  const rules = data.rules || [];
  const state = data.state || {};
  container.innerHTML = `
    <div class="alerts-panel">
      <div class="alerts-header">
        <h3>Alertas (${rules.length})</h3>
        <button class="btn" id="alerts-new-btn">+ Nueva regla</button>
      </div>
      ${rules.length === 0
        ? '<div class="muted" style="padding:12px">Sin reglas todavía. Crea una para recibir avisos.</div>'
        : `<table class="alerts-table">
            <thead><tr><th>Etiqueta</th><th>Servicio</th><th>Tipo</th><th>Umbral</th><th>Estado</th><th>Activa</th><th></th></tr></thead>
            <tbody>${rules.map(r => renderAlertRow(r, services, state[r.id])).join("")}</tbody>
          </table>`}
      <div id="alert-form" class="hidden"></div>
    </div>`;
  $("#alerts-new-btn").onclick = () => showAlertForm(null, rules, services);
  rules.forEach(r => {
    const e = document.getElementById(`alert-edit-${r.id}`);
    if (e) e.onclick = () => showAlertForm(r, rules, services);
    const d = document.getElementById(`alert-del-${r.id}`);
    if (d) d.onclick = () => deleteAlert(r.id, rules);
    const t = document.getElementById(`alert-toggle-${r.id}`);
    if (t) t.onchange = () => toggleAlertEnabled(r.id, t.checked, rules);
  });
}

function renderAlertRow(r, services, st) {
  const svc = services.find(s => s.id === r.service_id);
  const svcLabel = svc ? `${esc(svc.kind)}/${esc(svc.name)}` : `<i>(${esc(r.service_id)} no encontrado)</i>`;
  const stPill = st && st.firing
    ? `<span class="health-pill health-pill-bad">firing</span> <span class="muted">${esc((st.reason||"").substring(0, 50))}</span>`
    : `<span class="muted">ok</span>`;
  return `<tr>
    <td>${esc(r.label || "-")}</td>
    <td>${svcLabel}</td>
    <td><code>${esc(r.kind)}</code></td>
    <td>${r.threshold == null ? "-" : r.threshold}</td>
    <td>${stPill}</td>
    <td><input type="checkbox" id="alert-toggle-${r.id}" ${r.enabled ? "checked" : ""}/></td>
    <td>
      <button class="btn-mini" id="alert-edit-${r.id}">editar</button>
      <button class="btn-mini danger" id="alert-del-${r.id}">borrar</button>
    </td>
  </tr>`;
}

function showAlertForm(rule, rules, services) {
  const form = $("#alert-form");
  form.classList.remove("hidden");
  const r = rule || { id: "", service_id: services[0]?.id || "", kind: "cpu_above",
                      threshold: 80, enabled: true, label: "" };
  form.innerHTML = `
    <h4>${rule ? "Editar regla" : "Nueva regla"}</h4>
    <label>Etiqueta <input id="af-label" value="${esc(r.label||"")}" placeholder="Nombre descriptivo"/></label>
    <label>Servicio
      <select id="af-service">
        ${services.map(s => `<option value="${esc(s.id)}" ${s.id===r.service_id?"selected":""}>${esc(s.kind)} · ${esc(s.name)}</option>`).join("")}
      </select>
    </label>
    <label>Tipo
      <select id="af-kind">
        ${ALERT_KINDS_UI.map(k => `<option value="${k.value}" ${k.value===r.kind?"selected":""}>${esc(k.label)}</option>`).join("")}
      </select>
    </label>
    <label>Umbral <input id="af-threshold" type="number" min="0" max="100" step="1" value="${r.threshold ?? ""}" /></label>
    <label><input id="af-enabled" type="checkbox" ${r.enabled?"checked":""}/> Activa</label>
    <div class="modal-actions">
      <button class="btn" id="af-cancel">Cancelar</button>
      <button class="btn primary" id="af-save">Guardar</button>
    </div>`;
  const updateThresholdVisibility = () => {
    const k = $("#af-kind").value;
    const info = ALERT_KINDS_UI.find(x => x.value === k);
    $("#af-threshold").parentElement.style.display = (info && info.needsT) ? "block" : "none";
  };
  $("#af-kind").onchange = updateThresholdVisibility;
  updateThresholdVisibility();
  $("#af-cancel").onclick = () => form.classList.add("hidden");
  $("#af-save").onclick = async () => {
    const k = $("#af-kind").value;
    const needsT = ALERT_KINDS_UI.find(x => x.value === k)?.needsT;
    const updated = {
      id: r.id || "",
      service_id: $("#af-service").value,
      kind: k,
      threshold: needsT ? parseFloat($("#af-threshold").value) : null,
      enabled: $("#af-enabled").checked,
      label: $("#af-label").value,
    };
    if (needsT && (isNaN(updated.threshold) || updated.threshold < 0 || updated.threshold > 100)) {
      alert("Umbral inválido (0–100)"); return;
    }
    const next = rule
      ? rules.map(x => x.id === rule.id ? updated : x)
      : [...rules, updated];
    await saveAlerts(next);
  };
}

async function saveAlerts(rules) {
  const r = await fetch("/api/projects/alerts", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({client: selClient, project: selProject, rules})
  });
  if (!r.ok) {
    const e = await r.json().catch(()=>({error:"error"}));
    alert("Error: " + (e.error || r.status));
    return;
  }
  renderAlertsTab();
}

async function deleteAlert(id, rules) {
  if (!confirm("¿Borrar esta regla?")) return;
  await saveAlerts(rules.filter(r => r.id !== id));
}

async function toggleAlertEnabled(id, enabled, rules) {
  const next = rules.map(r => r.id === id ? {...r, enabled} : r);
  await saveAlerts(next);
}

function renderMap() {
  // Linear
  const ls = mapState.linear_status;
  const badge = $("#mapLinearBadge");
  badge.textContent = ls.has_project_token ? "configurado ✓" : "no configurado";
  badge.classList.toggle("ok", ls.has_project_token);
  badge.classList.toggle("muted", !ls.has_project_token);
  $("#mapLinearFallback").classList.toggle("hidden",
    ls.has_project_token || !ls.has_global_fallback);
  $("#mapLinearDel").classList.toggle("hidden", !ls.has_project_token);

  // Servicios
  const sList = $("#mapSvcList");
  sList.innerHTML = "";
  $("#mapSvcEmpty").classList.toggle("hidden", mapState.services.length > 0);
  for (const s of mapState.services) {
    const li = document.createElement("li"); li.className = "svc-row";
    const cfgPreview = Object.keys(s.config || {}).length
      ? Object.entries(s.config).slice(0, 3).map(([k,v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")
      : "—";
    li.innerHTML = `
      <span class="svc-kind-badge">${esc(s.kind)}</span>
      <span class="svc-name">${esc(s.name)}</span>
      <span class="svc-cfg">${esc(cfgPreview)}</span>
      <span class="row-actions">
        <button class="btn-mini" data-act="edit" data-id="${esc(s.id)}">Editar</button>
        <button class="btn-mini danger" data-act="del" data-id="${esc(s.id)}">Borrar</button>
      </span>`;
    sList.appendChild(li);
  }
  sList.querySelectorAll("button[data-act]").forEach(b => {
    b.onclick = () => b.dataset.act === "edit" ? openSvcModal(b.dataset.id) : deleteSvc(b.dataset.id);
  });

  // Conexiones
  const cList = $("#mapConnList");
  cList.innerHTML = "";
  $("#mapConnEmpty").classList.toggle("hidden", mapState.connections.length > 0);
  const nameById = id => (mapState.services.find(x => x.id === id) || {}).name || id;
  for (const c of mapState.connections) {
    const li = document.createElement("li"); li.className = "conn-row";
    const lbl = c.label ? ` <span class="conn-label">(${esc(c.label)})</span>` : "";
    li.innerHTML = `
      <span class="conn-text">${esc(nameById(c.from))} → ${esc(nameById(c.to))}${lbl}</span>
      <span class="row-actions">
        <button class="btn-mini danger" data-conn="${esc(c.id)}">Borrar</button>
      </span>`;
    cList.appendChild(li);
  }
  cList.querySelectorAll("button[data-conn]").forEach(b => {
    b.onclick = () => deleteConn(b.dataset.conn);
  });
}

function updateDirty() {
  const now = JSON.stringify({ services: mapState.services, connections: mapState.connections });
  const dirty = mapLoaded && now !== mapDirtyBaseline;
  $("#mapSave").disabled = !dirty;
  $("#mapDirtyHint").classList.toggle("hidden", !dirty);
}

// ---- modal de servicio (añadir / editar / borrar) ----------------------- //
let svcModalEditingId = null;  // null si añadiendo, id si editando

function openSvcModal(id) {
  svcModalEditingId = id || null;
  const svc = id ? mapState.services.find(x => x.id === id) : null;
  $("#svcModalTitle").textContent = svc ? "Editar servicio" : "Añadir servicio";
  $("#svcModalKind").value = svc ? svc.kind : "vps";
  $("#svcModalKind").disabled = !!svc;            // kind inmutable tras crear
  $("#svcModalName").value = svc ? svc.name : "";
  $("#svcModalConfig").value = svc ? JSON.stringify(svc.config || {}, null, 2) : "{}";
  $("#svcModalErr").textContent = "";
  $("#svcModal").classList.remove("hidden");
  $("#svcModalName").focus();
}

function closeSvcModal() {
  $("#svcModal").classList.add("hidden");
  svcModalEditingId = null;
}

function saveSvcFromModal() {
  const kind = $("#svcModalKind").value;
  const name = $("#svcModalName").value.trim();
  const cfgRaw = $("#svcModalConfig").value.trim() || "{}";
  if (!SVC_KINDS.includes(kind)) { $("#svcModalErr").textContent = "Tipo no válido."; return; }
  if (!name) { $("#svcModalErr").textContent = "El nombre es obligatorio."; return; }
  if (name.length > 100) { $("#svcModalErr").textContent = "Nombre demasiado largo (máx 100)."; return; }
  let cfg;
  try { cfg = JSON.parse(cfgRaw); }
  catch (e) { $("#svcModalErr").textContent = "Config debe ser JSON válido: " + e.message; return; }
  if (cfg === null) cfg = {};
  if (typeof cfg !== "object" || Array.isArray(cfg)) {
    $("#svcModalErr").textContent = "Config debe ser un objeto JSON."; return;
  }
  if (svcModalEditingId) {
    const i = mapState.services.findIndex(x => x.id === svcModalEditingId);
    if (i >= 0) mapState.services[i] = { ...mapState.services[i], name, config: cfg };
  } else {
    mapState.services.push({ id: "", kind, name, config: cfg });  // id lo asigna el backend
  }
  closeSvcModal();
  renderMap();
  updateDirty();
}

function deleteSvc(id) {
  const svc = mapState.services.find(x => x.id === id);
  if (!svc) return;
  if (!confirm(`Borrar servicio "${svc.name}"?\nTambién se borrarán las conexiones que lo referencian.`)) return;
  mapState.services = mapState.services.filter(x => x.id !== id);
  // Limpieza de conexiones huérfanas (evita 400 del backend al guardar)
  mapState.connections = mapState.connections.filter(c => c.from !== id && c.to !== id);
  renderMap();
  updateDirty();
}

$("#mapSvcAdd").onclick = () => openSvcModal(null);
$("#svcModalCancel").onclick = closeSvcModal;
$("#svcModalSave").onclick = saveSvcFromModal;

// ---- modal de conexión -------------------------------------------------- //
let connModalEditingId = null;  // siempre null en Fase 1 (sin edit de conexión, solo add/delete)

function openConnModal() {
  connModalEditingId = null;
  if (mapState.services.length < 2) {
    alert("Necesitas al menos 2 servicios para crear una conexión.");
    return;
  }
  const fromSel = $("#connModalFrom"); fromSel.innerHTML = "";
  const toSel = $("#connModalTo"); toSel.innerHTML = "";
  for (const s of mapState.services) {
    const optF = document.createElement("option"); optF.value = s.id; optF.textContent = `${s.name} [${s.kind}]`; fromSel.appendChild(optF);
    const optT = document.createElement("option"); optT.value = s.id; optT.textContent = `${s.name} [${s.kind}]`; toSel.appendChild(optT);
  }
  toSel.selectedIndex = Math.min(1, toSel.options.length - 1);
  $("#connModalLabel").value = "";
  $("#connModalErr").textContent = "";
  $("#connModal").classList.remove("hidden");
}

function closeConnModal() { $("#connModal").classList.add("hidden"); }

function saveConnFromModal() {
  const from = $("#connModalFrom").value;
  const to = $("#connModalTo").value;
  const label = $("#connModalLabel").value.trim();
  if (!from || !to) { $("#connModalErr").textContent = "Selecciona ambos extremos."; return; }
  if (from === to) { $("#connModalErr").textContent = "El origen y el destino no pueden ser el mismo servicio."; return; }
  if (label.length > 80) { $("#connModalErr").textContent = "Etiqueta demasiado larga (máx 80)."; return; }
  mapState.connections.push({ id: "", from, to, label });
  closeConnModal();
  renderMap();
  updateDirty();
}

function deleteConn(id) {
  const c = mapState.connections.find(x => x.id === id);
  if (!c) return;
  if (!confirm("Borrar conexión?")) return;
  mapState.connections = mapState.connections.filter(x => x.id !== id);
  renderMap();
  updateDirty();
}

$("#mapConnAdd").onclick = openConnModal;
$("#connModalCancel").onclick = closeConnModal;
$("#connModalSave").onclick = saveConnFromModal;

// ---- modal de token Linear --------------------------------------------- //
function openLinTokenModal() {
  $("#linTokenInput").value = "";
  $("#linTokenErr").textContent = "";
  $("#linTokenModal").classList.remove("hidden");
  $("#linTokenInput").focus();
}

function closeLinTokenModal() { $("#linTokenModal").classList.add("hidden"); }

async function saveLinTokenFromModal() {
  const tok = $("#linTokenInput").value.trim();
  if (!tok) { $("#linTokenErr").textContent = "Token vacío. Para borrarlo usa el botón 'Borrar token'."; return; }
  try {
    const r = await fetch("/api/projects/linear-token", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({client: selClient, project: selProject, token: tok}),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    closeLinTokenModal();
    // refresca solo el linear_status sin tocar el resto del estado
    mapState.linear_status.has_project_token = true;
    renderMap();
  } catch (e) {
    $("#linTokenErr").textContent = "No se pudo guardar: " + e.message;
  }
}

async function deleteLinToken() {
  if (!confirm("¿Borrar el token de Linear del proyecto? Pasarás a usar el global (si existe).")) return;
  try {
    const r = await fetch("/api/projects/linear-token", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({client: selClient, project: selProject, token: ""}),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    mapState.linear_status.has_project_token = false;
    renderMap();
  } catch (e) {
    alert("No se pudo borrar: " + e.message);
  }
}

$("#mapLinearSet").onclick = openLinTokenModal;
$("#mapLinearDel").onclick = deleteLinToken;
$("#linTokenCancel").onclick = closeLinTokenModal;
$("#linTokenSave").onclick = saveLinTokenFromModal;

// ---- Guardar metadata completa ----------------------------------------- //
async function saveMap() {
  if (!selClient || !selProject) return;
  $("#mapSave").disabled = true;
  $("#mapDirtyHint").textContent = "Guardando...";
  try {
    const r = await fetch("/api/projects/meta", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        client: selClient,
        project: selProject,
        services: mapState.services,
        connections: mapState.connections,
      }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    const data = await r.json();
    mapState.services = data.services || [];
    mapState.connections = data.connections || [];
    mapState.linear_status = data.linear_status || mapState.linear_status;
    mapDirtyBaseline = JSON.stringify({ services: mapState.services, connections: mapState.connections });
    renderMap();
    updateDirty();
    $("#mapDirtyHint").textContent = "";
  } catch (e) {
    alert("No se pudo guardar: " + e.message);
    $("#mapDirtyHint").textContent = "Cambios sin guardar";
    updateDirty();    // re-habilita el botón si seguía dirty
  }
}

$("#mapSave").onclick = saveMap;

// ---- repos (workspace de desarrollo) ----
function enterReposView() {
  $("#projbar").classList.remove("hidden");
  setCrumb();
  if (!current) {
    $("#projName").textContent = "—";
    ["#projBranch", "#branchSel", "#pullBtn", "#renameBtn", "#delBtn", "#convoToggle"].forEach(id => $(id).classList.add("hidden"));
    log.innerHTML = '<div class="meta">Clona o elige un repositorio de la izquierda.</div>';
  }
  renderConvoList();
  updateInputState();
}
async function loadRepos() {
  try { repos = (await (await fetch(`/api/repos?client=${encodeURIComponent(selClient)}&project=${encodeURIComponent(selProject)}`)).json()).repos || []; }
  catch (e) { repos = []; }
  if (current && !repos.find(r => r.name === current)) current = null;
  renderRepoList();
}
function renderRepoList() {
  const ul = $("#projList"); ul.innerHTML = "";
  if (!repos.length) { ul.innerHTML = '<li class="pmeta" style="padding:10px">Sin repos. Pulsa "+ Clonar".</li>'; return; }
  for (const p of repos) {
    const li = document.createElement("li");
    li.className = "proj" + (p.name === current ? " active" : "");
    const nm = document.createElement("div"); nm.className = "pname";
    if (pstate[repoKey(p.name)] && pstate[repoKey(p.name)].busy) {
      const s = document.createElement("span"); s.className = "spin"; nm.appendChild(s);
    }
    nm.appendChild(document.createTextNode(p.name));
    const meta = document.createElement("div"); meta.className = "pmeta";
    meta.textContent = (p.branch ? "⎇ " + p.branch : "(sin git)") + (p.dirty ? " • cambios" : "");
    li.appendChild(nm); li.appendChild(meta);
    li.onclick = () => selectRepo(p.name);
    ul.appendChild(li);
  }
}
function selectRepo(name) {
  current = name; localStorage.setItem("lastRepo", name);
  ["#projBranch", "#branchSel", "#pullBtn", "#renameBtn", "#delBtn", "#convoToggle"].forEach(id => $(id).classList.remove("hidden"));
  $("#projName").textContent = name;
  const p = repos.find(x => x.name === name);
  $("#projBranch").textContent = p && p.branch ? p.branch : "";
  renderRepoList(); renderConvoList(); renderLog(); loadBranches(name); updateInputState();
  $("#main-row").classList.remove("side-open");
  $("#input").focus();
}
function refreshRepobar() {
  const p = repos.find(x => x.name === current);
  $("#projBranch").textContent = p && p.branch ? p.branch : "";
}
$("#menuBtn").onclick = () => $("#main-row").classList.toggle("side-open");

// ---- conversaciones (por repo) ----
function renderConvoList() {
  const ul = $("#convoList"); ul.innerHTML = "";
  if (!current) { ul.innerHTML = '<li class="convo-empty">Elige un repositorio.</li>'; return; }
  const key = curKey(), s = st(key);
  s.convos.forEach((c, i) => {
    const li = document.createElement("li");
    li.className = "convo" + (c.id === s.activeId ? " active" : "");
    const t = document.createElement("span"); t.className = "ctitle"; t.textContent = c.title || ("Conversación " + (i + 1));
    const del = document.createElement("button"); del.className = "cdel"; del.textContent = "×"; del.title = "Borrar conversación";
    del.onclick = ev => { ev.stopPropagation(); deleteConvo(c.id); };
    li.appendChild(t); li.appendChild(del);
    li.onclick = () => switchConvo(c.id);
    ul.appendChild(li);
  });
}
function switchConvo(id) {
  if (!current) return;
  st(curKey()).activeId = id; saveConvos(curKey());
  renderConvoList(); renderLog(); updateInputState();
  if (window.matchMedia("(max-width:640px)").matches) $("#main-row").classList.remove("convo-open");
  $("#input").focus();
}
function deleteConvo(id) {
  if (!current) return;
  const key = curKey(), s = st(key);
  if (s.convos.length <= 1) { const c = s.convos[0]; c.entries = []; c.sessionId = null; c.title = "Conversación"; saveConvos(key); renderConvoList(); renderLog(); return; }
  if (!confirm("¿Borrar esta conversación?")) return;
  const idx = s.convos.findIndex(c => c.id === id);
  s.convos.splice(idx, 1);
  if (s.activeId === id) s.activeId = s.convos[Math.max(0, idx - 1)].id;
  saveConvos(key); renderConvoList(); renderLog(); updateInputState();
}
$("#newConvoBtn").onclick = () => {
  if (!current) { alert("Elige un repositorio primero."); return; }
  const key = curKey(), s = st(key), c = newConvoObj();
  s.convos.push(c); s.activeId = c.id; saveConvos(key);
  renderConvoList(); renderLog(); updateInputState(); $("#input").focus();
};
$("#convoToggle").onclick = () => {
  const mr = $("#main-row");
  if (window.matchMedia("(max-width:640px)").matches) mr.classList.toggle("convo-open");
  else mr.classList.toggle("convo-collapsed");
};

// ---- git sobre el repo ----
async function loadBranches(name) {
  const sel = $("#branchSel"); sel.innerHTML = "";
  try {
    const r = await fetch(`/api/repos/branches?client=${encodeURIComponent(selClient)}&project=${encodeURIComponent(selProject)}&name=${encodeURIComponent(name)}`);
    if (!r.ok) return;
    const j = await r.json();
    const locals = (j.branches || []).filter(b => !b.startsWith("origin"));
    const opts = locals.length ? locals : (j.current ? [j.current] : []);
    for (const b of opts) { const o = document.createElement("option"); o.value = b; o.textContent = b; if (b === j.current) o.selected = true; sel.appendChild(o); }
  } catch (e) {}
}
$("#branchSel").onchange = async e => {
  if (!current) return;
  const branch = e.target.value, c = activeConvo(curKey());
  const r = await fetch("/api/repos/checkout", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, project: selProject, name: current, branch}) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { pushTo(curKey(), c, {t: "meta", text: "✓ rama: " + branch}); await loadRepos(); refreshRepobar(); }
  else { pushTo(curKey(), c, {t: "meta", text: "⚠️ " + (j.error || "no se pudo cambiar de rama"), cls: "err"}); loadBranches(current); }
};
$("#pullBtn").onclick = async () => {
  if (!current) return;
  const c = activeConvo(curKey());
  pushTo(curKey(), c, {t: "meta", text: "git pull…"});
  const r = await fetch("/api/repos/pull", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, project: selProject, name: current}) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { pushTo(curKey(), c, {t: "meta", text: "✓ " + (j.output || "actualizado")}); await loadRepos(); refreshRepobar(); }
  else pushTo(curKey(), c, {t: "meta", text: "⚠️ " + (j.error || "fallo en pull"), cls: "err"});
};
$("#delBtn").onclick = async () => {
  if (!current) return;
  if (!confirm(`¿Borrar el repo "${current}" del servidor?`)) return;
  const name = current;
  const r = await fetch("/api/repos/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, project: selProject, name}) });
  if (r.ok) { delete pstate[repoKey(name)]; localStorage.removeItem("convos:" + repoKey(name)); localStorage.removeItem("active:" + repoKey(name)); current = null; await loadRepos(); enterReposView(); }
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo borrar"); }
};
$("#renameBtn").onclick = async () => {
  if (!current) return;
  const name = current;
  const nn = (prompt("Nuevo nombre del repo:", name) || "").trim();
  if (!nn || nn === name) return;
  const r = await fetch("/api/repos/rename", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, project: selProject, name, new_name: nn}) });
  if (r.ok) {
    const oldK = repoKey(name), newK = `${selClient}/${selProject}/${nn}`;
    if (pstate[oldK]) { pstate[newK] = pstate[oldK]; delete pstate[oldK]; }   // conserva conversaciones
    for (const k of ["convos:", "active:"]) { const v = localStorage.getItem(k + oldK); if (v) { localStorage.setItem(k + newK, v); localStorage.removeItem(k + oldK); } }
    current = nn; localStorage.setItem("lastRepo", nn);
    await loadRepos(); selectRepo(nn);
  } else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo renombrar"); }
};

// ---- clonar repo ----
$("#cloneBtn").onclick = () => {
  $("#cloneUrl").value = ""; $("#cloneName").value = ""; $("#cloneMsg").textContent = ""; $("#cloneMsg").style.color = "";
  $("#clone").classList.remove("hidden"); $("#cloneUrl").focus();
};
$("#cancelCloneBtn").onclick = () => $("#clone").classList.add("hidden");
async function doClone() {
  const url = $("#cloneUrl").value.trim(), name = $("#cloneName").value.trim();
  const msg = $("#cloneMsg"); msg.style.color = "";
  if (!url) { msg.textContent = "Pon una URL"; return; }
  msg.textContent = "Clonando… (puede tardar)";
  let r;
  try { r = await fetch("/api/repos/clone", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, project: selProject, url, name: name || undefined}) }); }
  catch (e) { msg.textContent = "Error de conexión"; return; }
  if (!r.ok) { let e = "No se pudo clonar"; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} msg.textContent = e; return; }
  const j = await r.json();
  $("#clone").classList.add("hidden");
  await loadRepos(); selectRepo(j.name);
}
$("#doCloneBtn").onclick = doClone;

// --------------------------------------------------------------------------- //
// Render del log + chat
// --------------------------------------------------------------------------- //
function appendEntry(e) {
  if (e.t === "user" || e.t === "claude") {
    const d = document.createElement("div"); d.className = "msg " + (e.t === "user" ? "user" : "claude");
    const b = document.createElement("div"); b.className = "bubble"; b.textContent = e.text; d.appendChild(b); log.appendChild(d);
  } else if (e.t === "chip") {
    const d = document.createElement("div"); d.className = "msg claude"; d.innerHTML = `<span class="chip">${e.html}</span>`; log.appendChild(d);
  } else if (e.t === "meta") {
    const d = document.createElement("div"); d.className = "meta " + (e.cls || ""); d.textContent = e.text; log.appendChild(d);
  }
  scroll();
}
function renderLog() {
  log.innerHTML = "";
  if (current) activeConvo(curKey()).entries.forEach(appendEntry);
}
function pushTo(key, convo, e) {
  convo.entries.push(e);
  if (key === curKey() && convo.id === st(key).activeId) appendEntry(e);
}
function updateInputState() {
  const busy = current && st(curKey()).busy;
  $("#sendBtn").disabled = !current || busy;
  $("#status").textContent = busy ? "trabajando…" : "listo";
  $("#input").placeholder = current ? "Escribe… (Enter envía, Shift+Enter salto)" : "Elige un repositorio…";
}
function setBusy(key, b) {
  st(key).busy = b; renderRepoList();
  if (key === curKey()) updateInputState();
}
async function send() {
  if (!current) { alert("Elige un repositorio primero."); return; }
  const key = curKey(), s = st(key);
  if (s.busy) return;
  const input = $("#input"), text = input.value.trim();
  if (!text) return;
  input.value = "";
  const convo = activeConvo(key);
  if (convo.title === "Conversación" && !convo.entries.length) { convo.title = text.slice(0, 32); saveConvos(key); renderConvoList(); }
  pushTo(key, convo, {t: "user", text});
  setBusy(key, true);
  const ctx = {client: selClient, project: selProject, repo: current};
  try {
    const r = await fetch("/api/chat", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({...ctx, message: text, session_id: convo.sessionId}) });
    if (r.status === 409) { pushTo(key, convo, {t: "meta", text: "Ocupado: este repo ya tiene una respuesta en curso.", cls: "err"}); setBusy(key, false); return; }
    if (!r.ok) { let e = "Error " + r.status; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} pushTo(key, convo, {t: "meta", text: e, cls: "err"}); setBusy(key, false); return; }
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    while (true) {
      const {value, done} = await reader.read(); if (done) break;
      buf += dec.decode(value, {stream: true}); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) handleEvent(key, convo, JSON.parse(line)); }
    }
  } catch (e) { pushTo(key, convo, {t: "meta", text: "Conexión interrumpida: " + e.message, cls: "err"}); }
  finally { setBusy(key, false); }
}
function handleEvent(key, convo, ev) {
  switch (ev.type) {
    case "text": pushTo(key, convo, {t: "claude", text: ev.text}); break;
    case "tool": {
      let arg = "";
      if (ev.input && ev.input.command) arg = ev.input.command;
      else if (ev.input && ev.input.file_path) arg = ev.input.file_path;
      else if (ev.input && ev.input.pattern) arg = ev.input.pattern;
      pushTo(key, convo, {t: "chip", html: `🔧 <code>${esc(ev.name)}</code> ${esc(String(arg).slice(0,120))}`});
      break;
    }
    case "tool_result": break;
    case "ratelimit": pushTo(key, convo, {t: "meta", text: "⏳ Límite de uso: " + (ev.info.rateLimitType || "") + " (" + (ev.info.status || "") + ")", cls: "err"}); break;
    case "error": pushTo(key, convo, {t: "meta", text: "⚠️ " + ev.text, cls: "err"}); break;
    case "done": if (ev.session_id) { convo.sessionId = ev.session_id; saveConvos(key); } break;
  }
}
$("#sendBtn").onclick = send;
$("#input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

// --------------------------------------------------------------------------- //
// Perfil: contraseña + 2FA + token de GitHub
// --------------------------------------------------------------------------- //
$("#profileBtn").onclick = async () => {
  $("#profileMsg").textContent = ""; $("#profileMsg").style.color = "";
  $("#curPw").value = ""; $("#newPw").value = ""; $("#newPw2").value = "";
  $("#totpMsg").textContent = ""; $("#totpMsg").style.color = "";
  $("#totpPw").value = ""; $("#totpResult").classList.add("hidden"); $("#qrBox").innerHTML = "";
  $("#ghToken").value = ""; $("#ghMsg").textContent = ""; $("#ghMsg").style.color = ""; $("#ghStatus").textContent = "…";
  $("#linearToken").value = ""; $("#linearMsg").textContent = ""; $("#linearMsg").style.color = ""; $("#linearStatus").textContent = "…";
  $("#profile").classList.remove("hidden"); $("#curPw").focus();
  try {
    const j = await (await fetch("/api/whoami")).json();
    $("#ghStatus").textContent = j.github_token_set ? "✓ token configurado" : "sin token configurado";
    $("#linearStatus").textContent = j.linear_token_set ? "✓ token configurado" : "sin token configurado";
  } catch (_) { $("#ghStatus").textContent = ""; $("#linearStatus").textContent = ""; }
};
$("#cancelPwBtn").onclick = () => $("#profile").classList.add("hidden");
async function savePassword() {
  const cur = $("#curPw").value, n1 = $("#newPw").value, n2 = $("#newPw2").value, msg = $("#profileMsg"); msg.style.color = "";
  if (n1 !== n2) { msg.textContent = "Las contraseñas nuevas no coinciden"; return; }
  if (n1.length < 8) { msg.textContent = "Mínimo 8 caracteres"; return; }
  let r;
  try { r = await fetch("/api/account/password", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({current_password: cur, new_password: n1}) }); }
  catch (e) { msg.textContent = "Error de conexión"; return; }
  if (r.ok) { msg.style.color = "#3fb950"; msg.textContent = "✓ Contraseña actualizada"; setTimeout(() => $("#profile").classList.add("hidden"), 1200); }
  else { let e = "No se pudo cambiar"; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} msg.textContent = e; }
}
$("#savePwBtn").onclick = savePassword;
$("#newPw2").addEventListener("keydown", e => { if (e.key === "Enter") savePassword(); });

$("#resetTotpBtn").onclick = async () => {
  const msg = $("#totpMsg"); msg.style.color = ""; msg.textContent = "";
  const pw = $("#totpPw").value;
  if (!pw) { msg.textContent = "Introduce tu contraseña actual"; return; }
  if (!confirm("¿Regenerar el 2FA? El código actual dejará de funcionar; deberás escanear el QR nuevo.")) return;
  let r;
  try { r = await fetch("/api/account/totp/reset", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({current_password: pw}) }); }
  catch (e) { msg.textContent = "Error de conexión"; return; }
  if (!r.ok) { let e = "No se pudo regenerar"; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} msg.textContent = e; return; }
  const j = await r.json();
  $("#qrBox").innerHTML = j.svg || ""; $("#totpSecret").textContent = j.secret || "";
  $("#totpResult").classList.remove("hidden"); $("#totpPw").value = "";
  msg.style.color = "#3fb950"; msg.textContent = "✓ Nuevo 2FA generado. Escanéalo ahora.";
};
async function saveGithubToken() {
  const msg = $("#ghMsg"); msg.style.color = ""; const token = $("#ghToken").value.trim();
  let r;
  try { r = await fetch("/api/account/github-token", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token}) }); }
  catch (e) { msg.textContent = "Error de conexión"; return; }
  if (r.ok) { const j = await r.json(); msg.style.color = "#3fb950"; msg.textContent = token ? "✓ Token guardado" : "✓ Token eliminado"; $("#ghToken").value = ""; $("#ghStatus").textContent = j.set ? "✓ token configurado" : "sin token configurado"; }
  else { let e = "No se pudo guardar"; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} msg.textContent = e; }
}
$("#saveGhBtn").onclick = saveGithubToken;
async function saveLinearToken() {
  const msg = $("#linearMsg"); msg.style.color = ""; const token = $("#linearToken").value.trim();
  let r;
  try { r = await fetch("/api/account/linear-token", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token}) }); }
  catch (e) { msg.textContent = "Error de conexión"; return; }
  if (r.ok) { const j = await r.json(); msg.style.color = "#3fb950"; msg.textContent = token ? "✓ Token guardado" : "✓ Token eliminado"; $("#linearToken").value = ""; $("#linearStatus").textContent = j.set ? "✓ token configurado" : "sin token configurado"; }
  else { let e = "No se pudo guardar"; try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {} msg.textContent = e; }
}
$("#saveLinearBtn").onclick = saveLinearToken;

// --------------------------------------------------------------------------- //
// Logout
// --------------------------------------------------------------------------- //
$("#logoutBtn").onclick = async () => {
  try { await fetch("/api/logout", {method: "POST"}); } catch (e) {}
  monStop();
  current = selClient = selProject = null;
  $("#app-header").classList.add("hidden");
  ["#clients-view", "#projects-view", "#main-row", "#mon-view", "#linear-view", "#monHost"].forEach(id => $(id).classList.add("hidden"));
  linearLoaded = false;
  $("#login").classList.remove("hidden");
  $("#pw").value = ""; $("#code").value = ""; $("#loginErr").textContent = ""; $("#pw").focus();
};

// --------------------------------------------------------------------------- //
// Monitorización: hosts SSH + informe en vivo (sistema / Docker / n8n / BD)
// --------------------------------------------------------------------------- //
let monHosts = [], monSel = null, monTimer = null, monLoading = false, monInited = false;

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + " " + u[i];
}
function fmtUptime(sec) {
  if (!sec) return "—"; sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return (d ? d + "d " : "") + (h ? h + "h " : "") + m + "m";
}
function barCls(p) { return p == null ? "" : p >= 90 ? "bad" : p >= 70 ? "warn" : ""; }
function metric(label, valTxt, pct) {
  const w = pct == null ? 0 : Math.min(100, pct);
  return `<div class="metric"><div class="ml"><span>${esc(label)}</span><b>${esc(valTxt)}</b></div>` +
         `<div class="bar ${barCls(pct)}"><span style="width:${w}%"></span></div></div>`;
}
function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }
const STATUS_CLS = { success: "ok", error: "bad", crashed: "bad", running: "run", waiting: "run", new: "run" };

async function monEnter() {
  if (!monInited) { monInited = true; await monLoadHosts(); }
  if (monSel) { monRender(null); monFetch(); }
  if ($("#monAuto").checked) monStartTimer();
}
function monStop() { if (monTimer) { clearInterval(monTimer); monTimer = null; } }
function monStartTimer() { monStop(); monTimer = setInterval(monFetch, 10000); }

async function monLoadHosts() {
  try { monHosts = (await (await fetch("/api/monitor/hosts")).json()).hosts || []; }
  catch (e) { monHosts = []; }
  const sel = $("#monHostSel"); sel.innerHTML = "";
  for (const h of monHosts) { const o = document.createElement("option"); o.value = h.id; o.textContent = h.name; sel.appendChild(o); }
  const saved = localStorage.getItem("monHost");
  monSel = monHosts.find(h => h.id === saved) ? saved : (monHosts[0] ? monHosts[0].id : null);
  if (monSel) sel.value = monSel;
  const has = monHosts.length > 0;
  $("#monGrid").classList.toggle("hidden", !has);
  $("#monEmpty").classList.toggle("hidden", has);
  ["#monRefresh", "#monAuto", "#monEditBtn", "#monHostSel"].forEach(id => $(id).disabled = !has);
}
$("#monHostSel").onchange = e => { monSel = e.target.value; localStorage.setItem("monHost", monSel); monRender(null); monFetch(); };
$("#monRefresh").onclick = () => monFetch();
$("#monAuto").onchange = e => { if (e.target.checked) { monStartTimer(); monFetch(); } else monStop(); };

async function monFetch() {
  if (!monSel || monLoading) return;
  monLoading = true; $("#monStatus").textContent = "actualizando…";
  try {
    const r = await fetch("/api/monitor/report?host=" + encodeURIComponent(monSel));
    const j = await r.json();
    if (!j.ok) { $("#monStatus").textContent = "✗ " + (j.error || "error"); monRenderError(j.error); }
    else { monRender(j); $("#monStatus").textContent = "✓ " + new Date().toLocaleTimeString(); }
  } catch (e) { $("#monStatus").textContent = "✗ sin conexión"; }
  finally { monLoading = false; }
}
function monRenderError(err) {
  $("#cardSys").querySelector(".mc-body").innerHTML =
    `<div class="mc-err">No se pudo conectar por SSH:</div><div class="mc-muted">${esc(err || "")}</div>` +
    `<div class="mc-muted" style="margin-top:8px">Comprueba que el panel tiene acceso SSH por clave a esta VPS (usuario, host, puerto y la clave autorizada).</div>`;
  ["#cardDocker", "#cardN8n", "#cardDb"].forEach(id => $(id).querySelector(".mc-body").innerHTML = '<div class="mc-muted">—</div>');
}

function monRender(j) {
  if (!j) { ["#cardSys", "#cardDocker", "#cardN8n", "#cardDb"].forEach(id => $(id).querySelector(".mc-body").innerHTML = '<div class="mc-muted">cargando…</div>'); return; }
  renderSys(j.system); renderDocker(j.docker); renderN8n(j.n8n); renderDb(j.db);
}

function renderSys(s) {
  if (!s) return;
  let h = "";
  h += metric("CPU", s.cpu_pct == null ? "n/d" : s.cpu_pct + "%", s.cpu_pct);
  if (s.mem) h += metric("Memoria", `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`, s.mem.pct);
  for (const d of (s.disk || [])) h += metric("Disco " + d.mount, `${fmtBytes(d.used)} / ${fmtBytes(d.size)}`, d.pct);
  h += '<div class="mc-sub">Detalles</div>';
  h += kv("Host", esc(s.hostname || "—"));
  h += kv("Kernel", esc(s.kernel || "—"));
  h += kv("Uptime", fmtUptime(s.uptime));
  h += kv("Carga", (s.loadavg || []).join("  ") + (s.ncpu ? `  <span class="mc-muted">(${s.ncpu} CPU)</span>` : ""));
  if (s.top && s.top.length) {
    h += '<div class="mc-sub">Top procesos (CPU)</div><table class="mtable"><tr><th>Proceso</th><th class="num">%CPU</th><th class="num">%MEM</th></tr>';
    for (const p of s.top.slice(0, 5)) h += `<tr><td class="nm">${esc(p.cmd)}</td><td class="num">${esc(p.cpu)}</td><td class="num">${esc(p.mem)}</td></tr>`;
    h += "</table>";
  }
  $("#cardSys").querySelector(".mc-body").innerHTML = h;
}

function renderDocker(d) {
  const body = $("#cardDocker").querySelector(".mc-body");
  if (!d || !d.available) { body.innerHTML = '<div class="mc-muted">Docker no disponible en esta VPS.</div>'; return; }
  if (!d.containers.length) { body.innerHTML = '<div class="mc-muted">Sin contenedores.</div>'; return; }
  const up = d.containers.filter(c => /^up/i.test(c.status || "") || c.state === "running").length;
  let h = `<div class="mc-muted">${up}/${d.containers.length} en ejecución</div>`;
  h += '<table class="mtable"><tr><th>Contenedor</th><th>Estado</th><th class="num">CPU</th><th class="num">MEM</th></tr>';
  for (const c of d.containers) {
    const run = /^up/i.test(c.status || "") || c.state === "running";
    h += `<tr><td class="nm" title="${esc(c.image)}">${esc(c.name)}</td>` +
         `<td><span class="pill ${run ? "ok" : "bad"}">${esc((c.status || c.state || "?").slice(0, 24))}</span></td>` +
         `<td class="num">${esc(c.cpu || "—")}</td><td class="num">${esc(c.mem || "—")}</td></tr>`;
  }
  body.innerHTML = h + "</table>";
}

function renderN8n(n) {
  const body = $("#cardN8n").querySelector(".mc-body");
  if (!n) { body.innerHTML = '<div class="mc-muted">—</div>'; return; }
  let h = "";
  const hc = n.health_ok ? "ok" : (n.health ? "bad" : "warn");
  h += kv("Healthcheck", `<span class="sdot ${hc}"></span>${n.health ? esc(n.health) : "n/d"}`);
  h += kv("Workflows activos", n.active == null ? "n/d" : `${n.active}${n.total_workflows != null ? " / " + n.total_workflows : ""}`);
  if (!n.db_ok) { h += '<div class="mc-muted" style="margin-top:8px">Ejecuciones: sin acceso a la BD (revisa contenedor/credenciales de PostgreSQL).</div>'; body.innerHTML = h; return; }
  const ex = n.exec24 || {}; const keys = Object.keys(ex);
  h += '<div class="mc-sub">Ejecuciones (24h)</div>';
  if (!keys.length) h += '<div class="mc-muted">Sin ejecuciones en las últimas 24h.</div>';
  else { h += '<div>'; for (const k of keys) h += `<span class="pill ${STATUS_CLS[k] || ""}" style="margin-right:6px">${esc(k)}: ${ex[k]}</span>`; h += "</div>"; }
  if (n.recent && n.recent.length) {
    h += '<div class="mc-sub">Últimas ejecuciones</div><table class="mtable"><tr><th>Workflow</th><th>Estado</th><th>Inicio</th></tr>';
    for (const e of n.recent) h += `<tr><td class="nm">${esc(e.workflow)}</td><td><span class="pill ${STATUS_CLS[e.status] || ""}">${esc(e.status)}</span></td><td class="mc-muted">${esc(e.started)}</td></tr>`;
    h += "</table>";
  }
  body.innerHTML = h;
}

function renderDb(d) {
  const body = $("#cardDb").querySelector(".mc-body");
  if (!d || (!d.configured && d.size == null && d.conns == null)) { body.innerHTML = '<div class="mc-muted">Sin contenedor de BD configurado.</div>'; return; }
  let h = "";
  h += kv("Estado", `<span class="sdot ${d.ready ? "ok" : "bad"}"></span>${d.ready ? "aceptando conexiones" : esc((d.isready || "no responde").slice(0, 40))}`);
  h += kv("Tamaño BD", d.size ? esc(d.size) : "n/d");
  h += kv("Conexiones activas", d.conns == null ? "n/d" : d.conns);
  h += kv("Versión", d.version ? esc(d.version) : "n/d");
  body.innerHTML = h;
}

// ---- modal de configuración de host ----
function monOpenHost(host) {
  $("#mhMsg").textContent = ""; $("#mhTestOut").classList.add("hidden"); $("#mhTestOut").innerHTML = "";
  const f = id => $(id);
  f("#mhId").value = host ? host.id : "";
  f("#mhName").value = host ? host.name : "";
  f("#mhUser").value = host ? host.ssh_user : "";
  f("#mhHost").value = host ? host.ssh_host : "";
  f("#mhPort").value = host ? host.ssh_port : 22;
  f("#mhKey").value = host ? (host.identity_file || "") : "";
  f("#mhN8nContainer").value = host ? (host.n8n_container || "") : "n8n";
  f("#mhN8nUrl").value = host ? (host.n8n_url || "") : "http://localhost:5678";
  f("#mhDbContainer").value = host ? (host.db_container || "") : "";
  f("#mhDbName").value = host ? (host.db_name || "") : "n8n";
  f("#mhDbUser").value = host ? (host.db_user || "") : "postgres";
  f("#mhDbPass").value = "";
  f("#mhDbPass").placeholder = host && host.db_password_set ? "•••••• (guardada — deja vacío para mantener)" : "contraseña BD (si hace falta)";
  $("#monHostTitle").textContent = host ? "Editar: " + host.name : "Nueva VPS";
  $("#mhDelBtn").classList.toggle("hidden", !host);
  $("#monHost").classList.remove("hidden"); $("#mhName").focus();
}
$("#monAddBtn").onclick = () => monOpenHost(null);
$("#monAddBtn2").onclick = () => monOpenHost(null);
$("#monEditBtn").onclick = () => { const h = monHosts.find(x => x.id === monSel); if (h) monOpenHost(h); };
$("#mhCancelBtn").onclick = () => $("#monHost").classList.add("hidden");

function mhPayload() {
  const p = {
    id: $("#mhId").value, name: $("#mhName").value.trim(),
    ssh_user: $("#mhUser").value.trim(), ssh_host: $("#mhHost").value.trim(),
    ssh_port: $("#mhPort").value || 22, identity_file: $("#mhKey").value.trim(),
    n8n_container: $("#mhN8nContainer").value.trim(), n8n_url: $("#mhN8nUrl").value.trim(),
    db_container: $("#mhDbContainer").value.trim(), db_name: $("#mhDbName").value.trim(),
    db_user: $("#mhDbUser").value.trim(),
  };
  if ($("#mhDbPass").value) p.db_password = $("#mhDbPass").value;
  return p;
}
async function mhSave(payload) {
  const r = await fetch("/api/monitor/hosts/save", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#mhMsg").textContent = j.error || "No se pudo guardar"; return null; }
  return j.host;
}
$("#mhSaveBtn").onclick = async () => {
  $("#mhMsg").textContent = "";
  const saved = await mhSave(mhPayload());
  if (!saved) return;
  $("#monHost").classList.add("hidden");
  monSel = saved.id; localStorage.setItem("monHost", monSel);
  await monLoadHosts(); $("#monHostSel").value = monSel; monRender(null); monFetch();
};
$("#mhTestBtn").onclick = async () => {
  const out = $("#mhTestOut"); out.classList.remove("hidden"); out.innerHTML = "Probando…";
  // guarda primero (test necesita el host en el servidor)
  const saved = await mhSave(mhPayload());
  if (!saved) { out.innerHTML = '<span class="mc-err">Corrige los campos antes de probar.</span>'; return; }
  $("#mhId").value = saved.id;
  try {
    const r = await fetch("/api/monitor/test", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: saved.id}) });
    const j = await r.json();
    if (!j.ok) { out.innerHTML = `<span class="mc-err">✗ ${esc(j.error || "fallo")}</span>`; return; }
    let h = `<div><span class="sdot ok"></span><b>${esc(j.hostname || "conectado")}</b></div>`;
    if (j.containers && j.containers.length) {
      h += '<div class="mc-muted" style="margin-top:6px">Contenedores (usa estos nombres arriba):</div>';
      for (const c of j.containers) h += `<div class="kv"><span class="k">${esc(c.name)}</span><span class="v mc-muted">${esc(c.status)}</span></div>`;
    } else h += '<div class="mc-muted" style="margin-top:6px">SSH OK. Docker sin contenedores o no instalado.</div>';
    out.innerHTML = h;
    await monLoadHosts(); $("#monHostSel").value = monSel = saved.id;
  } catch (e) { out.innerHTML = '<span class="mc-err">Error de conexión</span>'; }
};
$("#mhDelBtn").onclick = async () => {
  const id = $("#mhId").value; if (!id) return;
  if (!confirm("¿Borrar este host de monitorización?")) return;
  await fetch("/api/monitor/hosts/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id}) });
  $("#monHost").classList.add("hidden");
  monSel = null; localStorage.removeItem("monHost");
  await monLoadHosts(); monRender(null); if (monSel) monFetch();
};

// ---- Linear (todas las issues) -------------------------------------------- //
let linearLoaded = false, linIssues = [], linUser = "", linMine = false;
let linearCtx = "";   // Fase 1: "proj:<cliente>/<proyecto>" o "global"; fuerza refetch si cambia
// orden de los grupos por tipo de estado (lo "en curso" arriba)
const LINEAR_ORDER = { started: 0, unstarted: 1, backlog: 2, triage: 3, completed: 4, canceled: 5, "": 6 };

function _linearInProject() {
  return !!(selClient && selProject && devScreen === "repos");
}
function _updateLinearTitle() {
  const titleEl = $("#linearTitle");
  if (!titleEl) return;
  titleEl.textContent = _linearInProject()
    ? `Linear de ${selClient} / ${selProject}`
    : "Linear (global)";
}

async function linearEnter() {
  // si el contexto cambió (sin proyecto ↔ proyecto, o de un proyecto a otro), recarga
  const ctx = _linearInProject() ? `proj:${selClient}/${selProject}` : "global";
  if (ctx !== linearCtx) { linearLoaded = false; linearCtx = ctx; }
  _updateLinearTitle();
  if (!linearLoaded) await linearFetch();
}
async function linearFetch() {
  const meta = $("#linearMeta"), empty = $("#linearEmpty"), groups = $("#linearGroups");
  meta.textContent = "cargando…"; empty.classList.add("hidden");
  const inProject = _linearInProject();
  const url = inProject
    ? `/api/projects/linear/all?client=${encodeURIComponent(selClient)}&project=${encodeURIComponent(selProject)}`
    : "/api/linear/all";
  let j;
  try { j = await (await fetch(url)).json(); }
  catch (e) { meta.textContent = ""; empty.classList.remove("hidden"); empty.textContent = "Error de conexión."; return; }
  meta.textContent = "";
  if (!j.ok) {
    groups.innerHTML = ""; empty.classList.remove("hidden");
    empty.innerHTML = esc(j.error || "No se pudo cargar Linear.") +
      ' · Configura el token en <b>Perfil → Linear</b>.';
    $("#linearUser").textContent = "";
    return;
  }
  linearLoaded = true;
  linUser = j.user || "";
  linIssues = j.issues || [];
  $("#linearUser").textContent = linUser;
  // aviso de fallback: usando token global aunque hay proyecto activo
  if (inProject && j.source === "global") {
    meta.textContent = "usando token global (fallback)";
  }
  linPopulateFilters();
  linRender();
}
// rellena los desplegables a partir de los datos (orden alfabético, con conteo)
function linPopulateFilters() {
  const fill = (sel, vals) => {
    const cur = sel.value, first = sel.options[0];
    sel.innerHTML = ""; sel.appendChild(first);
    for (const [v, n] of vals) { const o = document.createElement("option"); o.value = v; o.textContent = `${v} (${n})`; sel.appendChild(o); }
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : "";
  };
  const count = key => {
    const m = new Map();
    for (const it of linIssues) { const v = it[key] || (key === "project" ? "(sin proyecto)" : key === "assignee" ? "(sin asignar)" : ""); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  fill($("#linProject"), count("project"));
  fill($("#linState"), count("state"));
  fill($("#linAssignee"), count("assignee"));
}
function linRender() {
  const groups = $("#linearGroups"), empty = $("#linearEmpty");
  const q = $("#linQ").value.trim().toLowerCase();
  const fp = $("#linProject").value, fs = $("#linState").value, fa = $("#linAssignee").value;
  const groupBy = $("#linGroup").value;
  let items = linIssues.filter(it => {
    if (linMine && !it.mine) return false;
    if (fp && (it.project || "(sin proyecto)") !== fp) return false;
    if (fs && it.state !== fs) return false;
    if (fa && (it.assignee || "(sin asignar)") !== fa) return false;
    if (q && !(it.id.toLowerCase().includes(q) || it.title.toLowerCase().includes(q))) return false;
    return true;
  });
  $("#linearMeta").textContent = `${items.length} de ${linIssues.length}`;
  if (!items.length) { groups.innerHTML = ""; empty.classList.remove("hidden"); empty.textContent = "Sin issues para este filtro."; return; }
  empty.classList.add("hidden");
  // agrupa
  const buckets = new Map();
  const keyOf = it => groupBy === "project" ? (it.project || "(sin proyecto)")
    : groupBy === "state" ? it.state
    : groupBy === "assignee" ? (it.assignee || "(sin asignar)") : "";
  for (const it of items) { const k = keyOf(it); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(it); }
  let order = [...buckets.entries()];
  if (groupBy === "state") order.sort((a, b) => (LINEAR_ORDER[a[1][0].stateType] ?? 9) - (LINEAR_ORDER[b[1][0].stateType] ?? 9) || a[0].localeCompare(b[0]));
  else if (groupBy) order.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  let h = "";
  for (const [name, arr] of order) {
    arr.sort((a, b) => (LINEAR_ORDER[a.stateType] ?? 9) - (LINEAR_ORDER[b.stateType] ?? 9) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    if (groupBy) {
      const dot = groupBy === "state" ? `<span class="lin-dot" style="background:${esc(arr[0].stateColor || "#888")}"></span>` : "";
      h += `<section class="lin-group"><h3>${dot}${esc(name)} <span class="lin-count">${arr.length}</span></h3>`;
    } else h += `<section class="lin-group">`;
    for (const it of arr) h += linCard(it, groupBy);
    h += "</section>";
  }
  groups.innerHTML = h;
}
function linCard(it, groupBy) {
  const prio = it.priority && it.priority > 0 ? `<span class="lin-prio p${it.priority}">${esc(it.priorityLabel || "")}</span>` : "";
  const tags = [];
  if (groupBy !== "state") tags.push(`<span class="lin-tag" style="border-color:${esc(it.stateColor || "var(--border)")}">${esc(it.state)}</span>`);
  if (groupBy !== "project" && it.project) tags.push(`<span class="lin-tag">${esc(it.project)}</span>`);
  if (groupBy !== "assignee") tags.push(`<span class="lin-tag${it.mine ? " mine" : ""}">${esc(it.assignee || "sin asignar")}</span>`);
  return `<a class="lin-card" href="${esc(it.url)}" target="_blank" rel="noopener">
    <div class="lin-row"><span class="lin-id">${esc(it.team)}·${esc(it.id)}</span>${prio}</div>
    <div class="lin-title">${esc(it.title)}</div>
    <div class="lin-row lin-tags">${tags.join("")}<span class="lin-when">${esc(when(it.updatedAt))}</span></div>
  </a>`;
}
["#linProject", "#linState", "#linAssignee", "#linGroup"].forEach(id => $(id).onchange = linRender);
$("#linQ").oninput = linRender;
$("#linMineBtn").onclick = () => { linMine = !linMine; $("#linMineBtn").classList.toggle("active", linMine); linRender(); };
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date(), ms = now - d, day = 864e5;
  if (ms < 36e5) return "hace " + Math.max(1, Math.round(ms / 6e4)) + " min";
  if (ms < day) return "hace " + Math.round(ms / 36e5) + " h";
  if (ms < 7 * day) return "hace " + Math.round(ms / day) + " d";
  return d.toLocaleDateString();
}
$("#linearRefresh").onclick = () => { linearLoaded = false; linearFetch(); };

// --------------------------------------------------------------------------- //
// Mapa 2D (Fase 7): vista simple en grid de tarjetas HTML/CSS, sin libs.
// El script map2d.js se carga como global antes que app.js (ver index.html).
// --------------------------------------------------------------------------- //
async function mapEnter() {
  if (typeof window.initMap2D === "function") {
    window.initMap2D();
  } else {
    console.error("map2d.js no se ha cargado");
  }
}

checkAuth();
