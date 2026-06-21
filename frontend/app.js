const $ = s => document.querySelector(s);
const log = $("#log");
function esc(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function scroll() { log.scrollTop = log.scrollHeight; }

// --------------------------------------------------------------------------- //
// Estado por proyecto (permite varios proyectos en paralelo)
// --------------------------------------------------------------------------- //
let projects = [];     // [{name, branch, dirty, remote, last, git}]
let current = null;    // proyecto activo (visible)
const pstate = {};     // name -> {sessionId, entries:[], busy}

function st(name) {
  if (!pstate[name]) {
    pstate[name] = {
      sessionId: localStorage.getItem("sess:" + name) || null,
      entries: [], busy: false,
    };
  }
  return pstate[name];
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
  $("#main-row").classList.remove("hidden");
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
// Render del log (desde el estado del proyecto activo)
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
  if (current) st(current).entries.forEach(appendEntry);
}
function addEntry(name, e) {            // añade al estado y pinta si es el visible
  st(name).entries.push(e);
  if (name === current) appendEntry(e);
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
  if (r.ok) { addEntry(current, {t: "meta", text: "✓ rama: " + branch}); await loadProjects(); refreshProjbar(); }
  else { addEntry(current, {t: "meta", text: "⚠️ " + (j.error || "no se pudo cambiar de rama"), cls: "err"}); loadBranches(current); }
};
$("#pullBtn").onclick = async () => {
  if (!current) return;
  addEntry(current, {t: "meta", text: "git pull…"});
  const r = await fetch("/api/projects/pull", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({name: current})
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { addEntry(current, {t: "meta", text: "✓ " + (j.output || "actualizado")}); await loadProjects(); refreshProjbar(); }
  else addEntry(current, {t: "meta", text: "⚠️ " + (j.error || "fallo en pull"), cls: "err"});
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
    delete pstate[name]; localStorage.removeItem("sess:" + name);
    current = null; $("#projbar").classList.add("hidden"); log.innerHTML = "";
    await loadProjects();
  } else { const j = await r.json().catch(() => ({})); alert(j.error || "No se pudo borrar"); }
};
$("#newBtn").onclick = () => {
  if (!current) return;
  const s = st(current); s.sessionId = null; localStorage.removeItem("sess:" + current);
  s.entries = []; renderLog();
  addEntry(current, {t: "meta", text: "Nueva conversación en " + current + "."});
  $("#input").focus();
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
// Chat (scoped al proyecto; varios pueden correr a la vez)
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
  addEntry(name, {t: "user", text});
  setBusy(name, true);
  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({message: text, session_id: s.sessionId, project: name})
    });
    if (r.status === 409) { addEntry(name, {t: "meta", text: "Ocupado: ya hay una respuesta en curso.", cls: "err"}); setBusy(name, false); return; }
    if (!r.ok) {
      let e = "Error " + r.status;
      try { const j = await r.json(); if (j.error) e = j.error; } catch (_) {}
      addEntry(name, {t: "meta", text: e, cls: "err"}); setBusy(name, false); return;
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
        if (line.trim()) handleEvent(name, JSON.parse(line));
      }
    }
  } catch (e) {
    addEntry(name, {t: "meta", text: "Conexión interrumpida: " + e.message, cls: "err"});
  } finally {
    setBusy(name, false);
  }
}
function handleEvent(name, ev) {
  switch (ev.type) {
    case "text":
      addEntry(name, {t: "claude", text: ev.text}); break;
    case "tool": {
      let arg = "";
      if (ev.input && ev.input.command) arg = ev.input.command;
      else if (ev.input && ev.input.file_path) arg = ev.input.file_path;
      else if (ev.input && ev.input.pattern) arg = ev.input.pattern;
      addEntry(name, {t: "chip", html: `🔧 <code>${esc(ev.name)}</code> ${esc(String(arg).slice(0,120))}`});
      break;
    }
    case "tool_result": break;
    case "ratelimit":
      addEntry(name, {t: "meta", text: "⏳ Límite de uso: " + (ev.info.rateLimitType || "") + " (" + (ev.info.status || "") + ")", cls: "err"});
      break;
    case "error":
      addEntry(name, {t: "meta", text: "⚠️ " + ev.text, cls: "err"}); break;
    case "done":
      if (ev.session_id) { st(name).sessionId = ev.session_id; localStorage.setItem("sess:" + name, ev.session_id); }
      if (ev.cost_usd != null) addEntry(name, {t: "meta", text: "✓ turno completado · ~$" + ev.cost_usd.toFixed(4)});
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
  $("#login").classList.remove("hidden");
  $("#pw").value = ""; $("#code").value = ""; $("#loginErr").textContent = "";
  $("#pw").focus();
};

checkAuth();
