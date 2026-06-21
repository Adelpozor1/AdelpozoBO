const $ = s => document.querySelector(s);
const log = $("#log");
let sessionId = localStorage.getItem("claude_session") || null;
let busy = false;

// ---- login ----
let totpOn = false;
async function checkAuth() {
  const r = await fetch("/api/whoami");
  const j = await r.json();
  totpOn = !!j.totp;
  if (totpOn) $("#code").classList.remove("hidden");
  if (j.authed) showApp();
}
async function doLogin() {
  const pw = $("#pw").value;
  const code = $("#code").value;
  const r = await fetch("/api/login", {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({password: pw, code: code})
  });
  if (r.ok) { showApp(); return; }
  let msg = "Credenciales incorrectas";
  try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) {}
  $("#loginErr").textContent = msg;
}
function showApp() {
  $("#login").classList.add("hidden");
  for (const id of ["#app-header", "#log", "#app-footer"]) $(id).classList.remove("hidden");
  $("#input").focus();
}
$("#loginBtn").onclick = doLogin;
$("#pw").addEventListener("keydown", e => {
  if (e.key === "Enter") { if (totpOn) $("#code").focus(); else doLogin(); }
});
$("#code").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

// ---- UI helpers ----
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  div.appendChild(b);
  log.appendChild(div);
  scroll();
  return b;
}
function addChip(html) {
  const div = document.createElement("div");
  div.className = "msg claude";
  div.innerHTML = `<span class="chip">${html}</span>`;
  log.appendChild(div); scroll();
}
function addMeta(text, cls) {
  const div = document.createElement("div");
  div.className = "meta " + (cls || "");
  div.textContent = text;
  log.appendChild(div); scroll();
}
function scroll() { log.scrollTop = log.scrollHeight; }
function esc(s) { return String(s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function setBusy(b) {
  busy = b;
  $("#sendBtn").disabled = b;
  $("#status").textContent = b ? "trabajando…" : "listo";
}

// ---- enviar mensaje ----
async function send() {
  if (busy) return;
  const input = $("#input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  addMsg("user", text);
  setBusy(true);

  let curBubble = null;  // burbuja de texto en curso

  try {
    const r = await fetch("/api/chat", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({message: text, session_id: sessionId})
    });
    if (r.status === 409) { addMeta("Ocupado: hay otra respuesta en curso.", "err"); setBusy(false); return; }
    if (!r.ok) { addMeta("Error " + r.status, "err"); setBusy(false); return; }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        handleEvent(JSON.parse(line), b => curBubble = b);
      }
    }
  } catch (e) {
    addMeta("Conexión interrumpida: " + e.message, "err");
  } finally {
    setBusy(false);
    input.focus();
  }
}

function handleEvent(ev, setBubble) {
  switch (ev.type) {
    case "text":
      addMsg("claude", ev.text);
      break;
    case "tool": {
      let arg = "";
      if (ev.input && ev.input.command) arg = ev.input.command;
      else if (ev.input && ev.input.file_path) arg = ev.input.file_path;
      else if (ev.input && ev.input.pattern) arg = ev.input.pattern;
      addChip(`🔧 <code>${esc(ev.name)}</code> ${esc(String(arg).slice(0,120))}`);
      break;
    }
    case "tool_result":
      break; // silencioso (evita ruido); quítale el break si quieres verlos
    case "ratelimit":
      addMeta("⏳ Límite de uso: " + (ev.info.rateLimitType || "") +
              " (" + (ev.info.status || "") + ")", "err");
      break;
    case "error":
      addMeta("⚠️ " + ev.text, "err");
      break;
    case "done":
      if (ev.session_id) { sessionId = ev.session_id; localStorage.setItem("claude_session", sessionId); }
      if (ev.cost_usd != null) addMeta("✓ turno completado · ~$" + ev.cost_usd.toFixed(4));
      break;
  }
}

$("#sendBtn").onclick = send;
$("#input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
$("#newBtn").onclick = () => {
  sessionId = null; localStorage.removeItem("claude_session");
  log.innerHTML = ""; addMeta("Nueva conversación.");
  $("#input").focus();
};

checkAuth();
