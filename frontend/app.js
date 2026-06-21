const $ = s => document.querySelector(s);
const log = $("#log");
function esc(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function scroll() { log.scrollTop = log.scrollHeight; }

// --------------------------------------------------------------------------- //
// Estado por proyecto: varias conversaciones, cada una con su sesión de Claude.
//   pstate[name] = { convos:[{id,title,sessionId,entries}], activeId, busy }
// (busy es por proyecto: el backend solo deja un turno a la vez por proyecto)
// --------------------------------------------------------------------------- //
let projects = [];     // [{name, branch, dirty, remote, last, git}]
let current = null;    // proyecto activo (visible)
const pstate = {};

function newConvoObj() {
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
           title: "Conversación", sessionId: null, entries: [] };
}
function st(name) {
  if (!pstate[name]) {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem("convos:" + name) || "[]"); } catch (_) {}
    let convos = saved.map(c => ({ id: c.id, title: c.title || "Conversación",
                                   sessionId: c.sessionId || null, entries: [] }));
    if (!convos.length) convos = [newConvoObj()];
    let activeId = localStorage.getItem("active:" + name);
    if (!convos.find(c => c.id === activeId)) activeId = convos[0].id;
    pstate[name] = { convos, activeId, busy: false };
  }
  return pstate[name];
}
function activeConvo(name) {
  const s = st(name);
  return s.convos.find(c => c.id === s.activeId) || s.convos[0];
}
function saveConvos(name) {
  const s = st(name);
  localStorage.setItem("convos:" + name,
    JSON.stringify(s.convos.map(c => ({ id: c.id, title: c.title, sessionId: c.sessionId }))));
  localStorage.setItem("active:" + name, s.activeId);
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
function showApp() {
  $("#login").classList.add("hidden");
  $("#app-header").classList.remove("hidden");
  setSection("dev");
  loadProjects().then(() => {
    const saved = localStorage.getItem("current");
    if (saved && projects.find(p => p.name === saved)) selectProject(saved);
  });
}
$("#loginBtn").onclick = doLogin;
$("#pw").addEventListener("keydown", e => {
  if (e.key === "Enter") { if (totpOn) $("#code").focus(); else doLogin(); }
});
$("#code").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

// --------------------------------------------------------------------------- //
// Secciones (Desarrollo / Monitorización)
// --------------------------------------------------------------------------- //
function setSection(s) {
  const dev = s === "dev";
  $("#tabDev").classList.toggle("active", dev);
  $("#main-row").classList.toggle("hidden", !dev);
  $("#mon-view").classList.toggle("hidden", dev);
}
$("#tabDev").onclick = () => setSection("dev");
// #tabMon está deshabilitado (sección de monitorización aún no activa)

// --------------------------------------------------------------------------- //
// Render del log (desde la conversación activa del proyecto visible)
// --------------------------------------------------------------------------- //
function appendEntry(e) {
  if (e.t === "user" || e.t === "claude") {
    const d = document.createElement("div");
    d.className = "msg " + (e.t === "user" ? "user" : "claude");
    const b = document.createElement("div");
    b.className = "bubble"; b.textContent = e.text;
    d.appendChild(b); log.appendChild(d);
  } else if (e.t === "chip") {
    const d = document.createElement("div");
    d.className = "msg claude";
    d.innerHTML = `<span class="chip">${e.html}</span>`;
    log.appendChild(d);
  } else if (e.t === "meta") {
    const d = document.createElement("div");
    d.className = "meta " + (e.cls || "");
    d.textContent = e.text; log.appendChild(d);
  }
  scroll();
}
function renderLog() {
  log.innerHTML = "";
  if (current) activeConvo(current).entries.forEach(appendEntry);
}
function pushTo(name, convo, e) {     // añade a una conversación y pinta si está visible
  convo.entries.push(e);
  if (name === current && convo.id === st(name).activeId) appendEntry(e);
}

// --------------------------------------------------------------------------- //
// Proyectos
// --------------------------------------------------------------------------- //
async function loadProjects() {
  try {
    const r = await fetch("/api/projects");
    const j = await r.json();
    projects = j.projects || [];
  } catch (e) { projects = []; }
  if (current && !projects.find(p => p.name === current)) {
    current = null; $("#projbar").classList.add("hidden"); log.innerHTML = "";
  }
  renderProjectList();
}
function renderProjectList() {
  const ul = $("#projList"); ul.innerHTML = "";
  if (!projects.length) {
    const li = document.createElement("li");
    li.className = "pmeta"; li.style.padding = "10px";
    li.textContent = 'No hay proyectos. Pulsa "+ Clonar".';
    ul.appendChild(li); return;
  }
  for (const p of projects) {
    const li = document.createElement("li");
    li.className = "proj" + (p.name === current ? " active" : "");
    const nm = document.createElement("div"); nm.className = "pname";
    if (pstate[p.name] && pstate[p.name].busy) {
      const s = document.createElement("span"); s.className = "spin"; nm.appendChild(s);
    }
    nm.appendChild(document.createTextNode(p.name));
    const meta = document.createElement("div"); meta.className = "pmeta";
    meta.textContent = (p.branch ? "⎇ " + p.branch : "(sin git)") + (p.dirty ? " • cambios" : "");
    li.appendChild(nm); li.appendChild(meta);
    li.onclick = () => selectProject(p.name);
    ul.appendChild(li);
  }
}
function selectProject(name) {
  current = name;
  localStorage.setItem("current", name);
  $("#projbar").classList.remove("hidden");
  $("#projName").textContent = name;
  refreshProjbar();
  renderProjectList();
  renderConvoSel();
  renderLog();
  loadBranches(name);
  updateInputState();
  $("#main-row").classList.remove("side-open");  // cierra el cajón en móvil
  $("#input").focus();
}
function refreshProjbar() {
  const p = projects.find(x => x.name === current);
  $("#projBranch").textContent = p && p.branch ? p.branch : "";
}

// ---- conversaciones ----
function renderConvoSel() {
  const sel = $("#convoSel"); sel.innerHTML = "";
  if (!current) return;
  const s = st(current);
  s.convos.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.title || ("Conversación " + (i + 1));
    if (c.id === s.activeId) o.selected = true;
    sel.appendChild(o);
  });
}
$("#convoSel").onchange = e => {
  if (!current) return;
  st(current).activeId = e.target.value;
  saveConvos(current);
  renderLog();
  updateInputState();
  $("#input").focus();
};
$("#newBtn").onclick = () => {
  if (!current) return;
  const s = st(current);
  const c = newConvoObj();
  s.convos.push(c); s.activeId = c.id;
  saveConvos(current);
  renderConvoSel(); renderLog(); updateInputState();
  $("#input").focus();
};

// ---- git ----
async function loadBranches(name) {
  const sel = $("#branchSel"); sel.innerHTML = "";
  try {
    const r = await fetch("/api/projects/branches?name=" + encodeURIComponent(name));
    if (!r.ok) return;
    const j = await r.json();
    const locals = (j.branches || []).filter(b => !b.startsWith("origin"));
    const opts = locals.length ? locals : (j.current ? [j.current] : []);
    for (const b of opts) {
      const o = document.createElement("option");
      o.value = b; o.textContent = b; if (b === j.current) o.selected = true;
      sel.appendChild(o);
    }
  } catch (e) {}
}
$("#branchSel").onchange = async e => {
  if (!current) return;
  const branch = e.target.value;
  const r = await fetch("/api/projects/checkout", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({name: current, branch})
  });
  const j = await r.json().catch(() => ({}));
  const c = activeConvo(current);
  if (r.ok) { pushTo(current, c, {t: "meta", text: "✓ rama: " + branch}); await loadProjects(); refreshProjbar(); }
  else { pushTo(current, c, {t: "meta", text: "⚠️ " + (j.error || "no se pudo cambiar de rama"), cls: "err"}); loadBranches(current); }
};
$("#pullBtn").onclick = async () => {
  if (!current) return;
  const c = activeConvo(current);
  pushTo(current, c, {t: "meta", text: "git pull…"});
  const r = await fetch("/api/projects/pull", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({name: current})
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { pushTo(current, c, {t: "meta", text: "✓ " + (j.output || "actualizado")}); await loadProjects(); refreshProjbar(); }
  else pushTo(current, c, {t: "meta", text: "⚠️ " + (j.error || "fallo en pull"), cls: "err"});
};
$("#delBtn").onclick = async () => {
  if (!current) return;
  if (!confirm(`¿Borrar el proyecto "${current}"? Se elimina la carpeta del servidor.`)) return;
  const name = current;
  const r = await fetch("/api/projects/delete", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({name})
  });
  if (r.ok) {
    delete pstate[name];
    localStorage.removeItem("convos:" + name); localStorage.removeItem("active:" + name);
    current = null; $("#projbar").classList.add("hidden"); log.innerHTML = "";
    await loadProjects();
  } else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo borrar"); }
};
$("#menuBtn").onclick = () => $("#main-row").classList.toggle("side-open");

// ---- clonar ----
$("#cloneBtn").onclick = () => {
  $("#cloneUrl").value = ""; $("#cloneName").value = "";
  $("#cloneMsg").textContent = ""; $("#cloneMsg").style.color = "";
  $("#clone").classList.remove("hidden"); $("#cloneUrl").focus();
};
$("#cancelCloneBtn").onclick = () => $("#clone").classList.add("hidden");
async function doClone() {
  const url = $("#cloneUrl").value.trim(), name = $("#cloneName").value.trim();
  const msg = $("#cloneMsg"); msg.style.color = "";
  if (!url) { msg.textContent = "Pon una URL"; return; }
  msg.textContent = "Clonando… (puede tardar)";
  let r;
  try {
    r = await fetch("/api/projects/clone", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({url, name: name || undefined})
    });
  } catch (e) { msg.textContent = "Error de conexión"; return; }
  if (!r.ok) {
    let e = "No se pudo clonar";
    try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {}
    msg.textContent = e; return;
  }
  const j = await r.json();
  $("#clone").classList.add("hidden");
  await loadProjects();
  selectProject(j.name);
}
$("#doCloneBtn").onclick = doClone;

// --------------------------------------------------------------------------- //
// Chat (scoped a proyecto + conversación)
// --------------------------------------------------------------------------- //
function updateInputState() {
  const busy = current && st(current).busy;
  $("#sendBtn").disabled = !current || busy;
  $("#status").textContent = busy ? "trabajando…" : "listo";
  $("#input").placeholder = current ? "Escribe… (Enter envía, Shift+Enter salto)" : "Selecciona un proyecto…";
}
function setBusy(name, b) {
  st(name).busy = b;
  renderProjectList();
  if (name === current) updateInputState();
}
async function send() {
  if (!current) { alert("Selecciona un proyecto primero."); return; }
  const name = current, s = st(name);
  if (s.busy) return;
  const input = $("#input"), text = input.value.trim();
  if (!text) return;
  input.value = "";
  const convo = activeConvo(name);
  if (convo.title === "Conversación" && !convo.entries.length) {
    convo.title = text.slice(0, 32); saveConvos(name); renderConvoSel();
  }
  pushTo(name, convo, {t: "user", text});
  setBusy(name, true);
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({message: text, session_id: convo.sessionId, project: name})
    });
    if (r.status === 409) { pushTo(name, convo, {t: "meta", text: "Ocupado: este proyecto ya tiene una respuesta en curso.", cls: "err"}); setBusy(name, false); return; }
    if (!r.ok) {
      let e = "Error " + r.status;
      try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {}
      pushTo(name, convo, {t: "meta", text: e, cls: "err"}); setBusy(name, false); return;
    }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) handleEvent(name, convo, JSON.parse(line));
      }
    }
  } catch (e) {
    pushTo(name, convo, {t: "meta", text: "Conexión interrumpida: " + e.message, cls: "err"});
  } finally {
    setBusy(name, false);
  }
}
function handleEvent(name, convo, ev) {
  switch (ev.type) {
    case "text":
      pushTo(name, convo, {t: "claude", text: ev.text}); break;
    case "tool": {
      let arg = "";
      if (ev.input && ev.input.command) arg = ev.input.command;
      else if (ev.input && ev.input.file_path) arg = ev.input.file_path;
      else if (ev.input && ev.input.pattern) arg = ev.input.pattern;
      pushTo(name, convo, {t: "chip", html: `🔧 <code>${esc(ev.name)}</code> ${esc(String(arg).slice(0,120))}`});
      break;
    }
    case "tool_result": break;
    case "ratelimit":
      pushTo(name, convo, {t: "meta", text: "⏳ Límite de uso: " + (ev.info.rateLimitType || "") + " (" + (ev.info.status || "") + ")", cls: "err"});
      break;
    case "error":
      pushTo(name, convo, {t: "meta", text: "⚠️ " + ev.text, cls: "err"}); break;
    case "done":
      if (ev.session_id) { convo.sessionId = ev.session_id; saveConvos(name); }
      if (ev.cost_usd != null) pushTo(name, convo, {t: "meta", text: "✓ turno completado · ~$" + ev.cost_usd.toFixed(4)});
      break;
  }
}
$("#sendBtn").onclick = send;
$("#input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// --------------------------------------------------------------------------- //
// Perfil: contraseña + 2FA
// --------------------------------------------------------------------------- //
$("#profileBtn").onclick = () => {
  $("#profileMsg").textContent = ""; $("#profileMsg").style.color = "";
  $("#curPw").value = ""; $("#newPw").value = ""; $("#newPw2").value = "";
  $("#totpMsg").textContent = ""; $("#totpMsg").style.color = "";
  $("#totpPw").value = ""; $("#totpResult").classList.add("hidden"); $("#qrBox").innerHTML = "";
  $("#profile").classList.remove("hidden");
  $("#curPw").focus();
};
$("#cancelPwBtn").onclick = () => $("#profile").classList.add("hidden");
async function savePassword() {
  const cur = $("#curPw").value, n1 = $("#newPw").value, n2 = $("#newPw2").value;
  const msg = $("#profileMsg"); msg.style.color = "";
  if (n1 !== n2) { msg.textContent = "Las contraseñas nuevas no coinciden"; return; }
  if (n1.length < 8) { msg.textContent = "Mínimo 8 caracteres"; return; }
  let r;
  try {
    r = await fetch("/api/account/password", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({current_password: cur, new_password: n1})
    });
  } catch (e) { msg.textContent = "Error de conexión"; return; }
  if (r.ok) {
    msg.style.color = "#3fb950"; msg.textContent = "✓ Contraseña actualizada";
    setTimeout(() => $("#profile").classList.add("hidden"), 1200);
  } else {
    let e = "No se pudo cambiar";
    try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {}
    msg.textContent = e;
  }
}
$("#savePwBtn").onclick = savePassword;
$("#newPw2").addEventListener("keydown", e => { if (e.key === "Enter") savePassword(); });

$("#resetTotpBtn").onclick = async () => {
  const msg = $("#totpMsg"); msg.style.color = ""; msg.textContent = "";
  const pw = $("#totpPw").value;
  if (!pw) { msg.textContent = "Introduce tu contraseña actual"; return; }
  if (!confirm("¿Regenerar el 2FA? El código actual dejará de funcionar; deberás escanear el QR nuevo.")) return;
  let r;
  try {
    r = await fetch("/api/account/totp/reset", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({current_password: pw})
    });
  } catch (e) { msg.textContent = "Error de conexión"; return; }
  if (!r.ok) {
    let e = "No se pudo regenerar";
    try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {}
    msg.textContent = e; return;
  }
  const j = await r.json();
  $("#qrBox").innerHTML = j.svg || "";
  $("#totpSecret").textContent = j.secret || "";
  $("#totpResult").classList.remove("hidden");
  $("#totpPw").value = "";
  msg.style.color = "#3fb950"; msg.textContent = "✓ Nuevo 2FA generado. Escanéalo ahora.";
};

// --------------------------------------------------------------------------- //
// Logout
// --------------------------------------------------------------------------- //
$("#logoutBtn").onclick = async () => {
  try { await fetch("/api/logout", {method: "POST"}); } catch (e) {}
  current = null;
  $("#app-header").classList.add("hidden");
  $("#main-row").classList.add("hidden");
  $("#mon-view").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#pw").value = ""; $("#code").value = ""; $("#loginErr").textContent = "";
  $("#pw").focus();
};

checkAuth();
