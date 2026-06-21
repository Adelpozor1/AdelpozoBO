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
  setSection("dev");
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
  const dev = s === "dev";
  $("#tabDev").classList.toggle("active", dev);
  $("#mon-view").classList.toggle("hidden", dev);
  if (dev) showDev(devScreen);
  else ["#clients-view", "#projects-view", "#main-row"].forEach(id => $(id).classList.add("hidden"));
}
$("#tabDev").onclick = () => setSection("dev");

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
  if (r.ok) loadClients();
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo crear"); }
};
async function delClient(name) {
  if (!confirm(`¿Borrar el cliente "${name}" y TODOS sus proyectos y repos?`)) return;
  const r = await fetch("/api/clients/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name}) });
  if (r.ok) loadClients(); else alert("No se pudo borrar");
}
async function renameClient(name) {
  const nn = (prompt("Nuevo nombre del cliente:", name) || "").trim();
  if (!nn || nn === name) return;
  const r = await fetch("/api/clients/rename", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({name, new_name: nn}) });
  if (r.ok) { if (selClient === name) { selClient = nn; localStorage.setItem("lastClient", nn); } loadClients(); }
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
  if (r.ok) loadProjects();
  else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo crear"); }
};
async function delProject(name) {
  if (!confirm(`¿Borrar el proyecto "${name}" y todos sus repos?`)) return;
  const r = await fetch("/api/projects/delete", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, name}) });
  if (r.ok) loadProjects(); else alert("No se pudo borrar");
}
async function renameProject(name) {
  const nn = (prompt("Nuevo nombre del proyecto:", name) || "").trim();
  if (!nn || nn === name) return;
  const r = await fetch("/api/projects/rename", { method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({client: selClient, name, new_name: nn}) });
  if (r.ok) { if (selProject === name) { selProject = nn; localStorage.setItem("lastProject", nn); } loadProjects(); }
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
  $("#profile").classList.remove("hidden"); $("#curPw").focus();
  try { const j = await (await fetch("/api/whoami")).json(); $("#ghStatus").textContent = j.github_token_set ? "✓ token configurado" : "sin token configurado"; }
  catch (_) { $("#ghStatus").textContent = ""; }
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

// --------------------------------------------------------------------------- //
// Logout
// --------------------------------------------------------------------------- //
$("#logoutBtn").onclick = async () => {
  try { await fetch("/api/logout", {method: "POST"}); } catch (e) {}
  current = selClient = selProject = null;
  $("#app-header").classList.add("hidden");
  ["#clients-view", "#projects-view", "#main-row", "#mon-view"].forEach(id => $(id).classList.add("hidden"));
  $("#login").classList.remove("hidden");
  $("#pw").value = ""; $("#code").value = ""; $("#loginErr").textContent = ""; $("#pw").focus();
};

checkAuth();
