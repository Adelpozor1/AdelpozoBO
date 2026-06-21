#!/usr/bin/env python3
"""
Panel web para hablar con Claude (agéntico) y que toque esta VPS.

Sin dependencias externas: solo la stdlib de Python + el CLI `claude` ya
instalado y autenticado. Hace de puente:

  Navegador (chat) --POST /api/chat--> este servidor --subprocess--> claude -p
                                            |
                       NDJSON streaming  <--+  (texto, herramientas, coste)

Sesión: el navegador guarda el session_id de Claude y lo reenvía en cada
mensaje (--resume), así la conversación tiene memoria. /api/new la reinicia.

Auth: contraseña -> cookie firmada (HMAC). Pensado para ir tras un túnel SSH
o un reverse proxy con TLS (ver README).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONF_PATH = BASE / "panel.conf"
# El frontend vive en un repo/carpeta aparte; por defecto el hermano ../frontend.
# Se puede cambiar con "staticdir" en panel.conf (mismo origen → la cookie sigue
# funcionando, sin CORS).
DEFAULT_STATIC = BASE.parent / "frontend"


# --------------------------------------------------------------------------- #
# 2FA: TOTP (RFC 6238) — compatible con Google Authenticator, Authy, 1Password…
# Todo con la stdlib: nada que instalar, el secreto nunca sale de la VPS.
# --------------------------------------------------------------------------- #
TOTP_STEP = 30   # segundos por código
TOTP_DIGITS = 6
TOTP_WINDOW = 1  # acepta el código anterior/siguiente (tolera desfase de reloj)


def generate_totp_secret() -> str:
    """Secreto base32 (160 bits) que se introduce en la app autenticadora."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret_b32: str, counter: int) -> str:
    pad = "=" * ((8 - len(secret_b32) % 8) % 8)
    key = base64.b32decode(secret_b32.upper() + pad)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)


def verify_totp(secret_b32: str, code: str) -> bool:
    code = (code or "").strip().replace(" ", "")
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return False
    counter = int(time.time()) // TOTP_STEP
    for off in range(-TOTP_WINDOW, TOTP_WINDOW + 1):
        if hmac.compare_digest(_hotp(secret_b32, counter + off), code):
            return True
    return False


def totp_uri(cfg: dict) -> str:
    """URI otpauth:// para inscribir la cuenta (QR o introducción manual)."""
    issuer = cfg.get("totp_issuer", "Claude Panel")
    account = cfg.get("totp_account", "panel")
    label = urllib.parse.quote(f"{issuer}:{account}")
    params = urllib.parse.urlencode({
        "secret": cfg["totp_secret"],
        "issuer": issuer,
        "algorithm": "SHA1",
        "digits": TOTP_DIGITS,
        "period": TOTP_STEP,
    })
    return f"otpauth://totp/{label}?{params}"


def print_enrollment(cfg: dict) -> None:
    """Muestra cómo dar de alta el 2FA (secreto + URI; QR si hay `qrencode`)."""
    uri = totp_uri(cfg)
    print("-" * 60)
    print("  2FA (TOTP) — inscríbelo UNA vez en tu app autenticadora")
    print("  (Google Authenticator / Authy / 1Password):")
    print()
    print(f"    Secreto (entrada manual): {cfg['totp_secret']}")
    print(f"    o pega esta URI/QR      : {uri}")
    print()
    qrencode = shutil.which("qrencode")
    if qrencode:
        try:
            subprocess.run([qrencode, "-t", "ANSIUTF8", uri], check=False)
        except Exception:
            qrencode = None
    if not qrencode:
        # Sin `qrencode`: generamos el QR con nuestro módulo en Python puro.
        try:
            import qr
            print(qr.render(uri))
        except Exception as exc:  # nunca debe romper el arranque por esto
            print(f"    (no se pudo dibujar el QR: {exc};")
            print("     usa el secreto de arriba en entrada manual)")
    print("-" * 60)


# --------------------------------------------------------------------------- #
# Config (se autogenera en el primer arranque)
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    if CONF_PATH.exists():
        cfg = json.loads(CONF_PATH.read_text())
    else:
        cfg = {}
    changed = False
    if not cfg.get("password"):
        cfg["password"] = secrets.token_urlsafe(12)
        changed = True
    if not cfg.get("secret"):
        cfg["secret"] = secrets.token_hex(32)
        changed = True
    if not cfg.get("totp_secret"):
        cfg["totp_secret"] = generate_totp_secret()
        changed = True
    cfg.setdefault("totp_enabled", True)   # 2FA obligatorio para entrar
    cfg.setdefault("totp_issuer", "Claude Panel")
    cfg.setdefault("totp_account", os.environ.get("USER") or "panel")
    cfg.setdefault("host", "127.0.0.1")
    cfg.setdefault("port", 8787)
    cfg.setdefault("staticdir", str(DEFAULT_STATIC))  # carpeta del frontend
    cfg.setdefault("workdir", str(Path.home()))
    cfg.setdefault("model", None)  # p.ej. "opus", "sonnet"; None = el del CLI
    cfg.setdefault("claude_bin", None)  # ruta al CLI; None = autodetectar
    cfg.setdefault("cookie_secure", True)  # cookie solo por HTTPS (Tailscale serve)
    cfg.setdefault("session_days", 30)     # caducidad de la sesión
    cfg.setdefault("projects_dir", str(Path.home() / "projects"))  # zona de desarrollo
    cfg.setdefault("github_token", "")     # para clonar privados por HTTPS (sin SSH)
    if changed or not CONF_PATH.exists():
        CONF_PATH.write_text(json.dumps(cfg, indent=2))
        os.chmod(CONF_PATH, 0o600)
    return cfg


def save_config(cfg: dict) -> None:
    """Reescribe panel.conf (permisos 600). Usado por --set-password/--reset-totp."""
    CONF_PATH.write_text(json.dumps(cfg, indent=2))
    os.chmod(CONF_PATH, 0o600)


CFG = load_config()
STATIC = Path(CFG["staticdir"]).resolve()


def resolve_claude_bin() -> str:
    """Ruta absoluta al CLI `claude`. Como servicio systemd el PATH es mínimo y
    no incluye ~/.local/bin, así que lo buscamos a mano."""
    cand = CFG.get("claude_bin")
    if cand and Path(cand).exists():
        return cand
    found = shutil.which("claude")
    if found:
        return found
    for p in (Path.home() / ".local/bin/claude", Path("/usr/local/bin/claude")):
        if p.exists():
            return str(p)
    return "claude"  # último recurso (dará un error claro al usarlo)


CLAUDE_BIN = resolve_claude_bin()


# --------------------------------------------------------------------------- #
# Zona de desarrollo: cada proyecto es una subcarpeta de PROJECTS (un git clone).
# Claude trabaja con cwd dentro del proyecto; varios proyectos pueden correr a la
# vez (un lock por proyecto, no global).
# --------------------------------------------------------------------------- #
PROJECTS = Path(CFG["projects_dir"]).resolve()

GIT_ENV = {
    **os.environ,
    "GIT_TERMINAL_PROMPT": "0",  # nunca pedir credenciales (colgaría)
    "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
}


def git_auth_args() -> list[str]:
    """Si hay token de GitHub, manda Authorization solo a github.com (HTTPS).
    Vía -c (no se persiste en .git/config, no queda el token en el repo)."""
    tok = CFG.get("github_token")
    if not tok:
        return []
    b64 = base64.b64encode(("x-access-token:" + tok).encode()).decode()
    return ["-c", f"http.https://github.com/.extraHeader=Authorization: Basic {b64}"]


def run_git(args: list[str], cwd=None, timeout: int = 300):
    try:
        p = subprocess.run(["git", *git_auth_args(), *args], cwd=cwd, env=GIT_ENV,
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "tiempo de espera agotado"
    except FileNotFoundError:
        return 127, "", "git no está instalado"


def valid_name(name: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", name or "")) and ".." not in name


def project_path(name: str, must_exist: bool = True):
    """Ruta segura de un proyecto (hijo directo de PROJECTS). None si inválida."""
    if not valid_name(name):
        return None
    p = (PROJECTS / name).resolve()
    if p.parent != PROJECTS:
        return None
    if must_exist and not p.is_dir():
        return None
    return p


def name_from_url(url: str) -> str:
    base = url.rstrip("/").split("/")[-1]
    if base.endswith(".git"):
        base = base[:-4]
    base = re.sub(r"[^A-Za-z0-9._-]", "-", base).strip("-.") or "repo"
    return base


# Un lock por proyecto: permite varios proyectos en paralelo, pero solo un
# turno de Claude a la vez dentro de cada uno (evita --resume concurrente).
_locks_guard = threading.Lock()
_proj_locks: dict = {}


def project_lock(name: str) -> threading.Lock:
    with _locks_guard:
        return _proj_locks.setdefault(name, threading.Lock())

# Anti-fuerza-bruta del login: tras varios fallos, bloqueo temporal.
_login_lock = threading.Lock()
_login_fails = 0
_login_blocked_until = 0.0
MAX_LOGIN_FAILS = 5
LOCKOUT_SECONDS = 300


def login_blocked_for() -> float:
    """Segundos restantes de bloqueo (0 si se puede intentar)."""
    with _login_lock:
        return max(0.0, _login_blocked_until - time.time())


def register_login_result(ok: bool) -> None:
    global _login_fails, _login_blocked_until
    with _login_lock:
        if ok:
            _login_fails = 0
            _login_blocked_until = 0.0
        else:
            _login_fails += 1
            if _login_fails >= MAX_LOGIN_FAILS:
                _login_blocked_until = time.time() + LOCKOUT_SECONDS
                _login_fails = 0


# --------------------------------------------------------------------------- #
# Contraseña: hash scrypt (en vez de texto plano). Compatible hacia atrás con
# el campo `password` heredado mientras no se ejecute --set-password.
# --------------------------------------------------------------------------- #
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${dk.hex()}"


def verify_password(pw: str) -> bool:
    stored = CFG.get("password_hash")
    if stored:
        try:
            algo, n, r, p, salt_hex, hash_hex = stored.split("$")
            if algo != "scrypt":
                return False
            dk = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt_hex),
                                n=int(n), r=int(r), p=int(p), dklen=len(hash_hex) // 2)
            return hmac.compare_digest(dk.hex(), hash_hex)
        except Exception:
            return False
    legacy = CFG.get("password")  # texto plano del primer arranque
    return bool(legacy) and hmac.compare_digest(pw, str(legacy))


# --------------------------------------------------------------------------- #
# Sesiones: token aleatorio por login, con caducidad y revocables (logout).
# Persisten en sessions.json para sobrevivir reinicios.
# --------------------------------------------------------------------------- #
SESS_PATH = BASE / "sessions.json"
_sess_lock = threading.Lock()


def _load_sessions() -> dict:
    try:
        return json.loads(SESS_PATH.read_text())
    except Exception:
        return {}


_sessions = _load_sessions()  # token -> epoch de expiración


def _save_sessions_locked() -> None:
    try:
        SESS_PATH.write_text(json.dumps(_sessions))
        os.chmod(SESS_PATH, 0o600)
    except Exception:
        pass


def session_ttl() -> int:
    return int(CFG.get("session_days", 30)) * 86400


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _sess_lock:
        for t in [t for t, exp in _sessions.items() if exp < now]:  # purga caducadas
            del _sessions[t]
        _sessions[token] = now + session_ttl()
        _save_sessions_locked()
    return token


def session_valid(token: str) -> bool:
    if not token:
        return False
    with _sess_lock:
        exp = _sessions.get(token)
        if exp is None:
            return False
        if exp < time.time():
            del _sessions[token]
            _save_sessions_locked()
            return False
        return True


def destroy_session(token: str) -> None:
    with _sess_lock:
        if _sessions.pop(token, None) is not None:
            _save_sessions_locked()


def clear_sessions() -> None:
    with _sess_lock:
        _sessions.clear()
        _save_sessions_locked()


def make_cookie(token: str, max_age: int) -> str:
    flags = "HttpOnly; SameSite=Strict; Path=/"
    if CFG.get("cookie_secure", True):
        flags += "; Secure"
    return f"auth={token}; {flags}; Max-Age={max_age}"


# --------------------------------------------------------------------------- #
# Handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # cierre de conexión delimita el streaming
    server_version = "ClaudePanel/1"

    def log_message(self, fmt, *args):  # logging compacto
        print(f"{self.address_string()} {fmt % args}")

    # -- helpers ----------------------------------------------------------- #
    def _cookie_token(self) -> str:
        morsel = SimpleCookie(self.headers.get("Cookie", "")).get("auth")
        return morsel.value if morsel else ""

    def _is_authed(self) -> bool:
        return session_valid(self._cookie_token())

    def _send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; frame-ancestors 'none'; base-uri 'none'")

    def _send(self, code: int, body: bytes, ctype: str, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._send_security_headers()
        for k, v in (extra_headers or {}):
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict, extra_headers=None):
        self._send(code, json.dumps(obj).encode(), "application/json", extra_headers)

    def _serve_static(self, name: str):
        path = (STATIC / name).resolve()
        if not str(path).startswith(str(STATIC)) or not path.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".css": "text/css",
        }.get(path.suffix, "application/octet-stream")
        self._send(200, path.read_bytes(), ctype)

    # -- GET --------------------------------------------------------------- #
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/") :])
        elif path == "/api/whoami":
            authed = self._is_authed()
            resp = {"authed": authed, "totp": bool(CFG.get("totp_enabled"))}
            if authed:
                resp["github_token_set"] = bool(CFG.get("github_token"))
            self._json(200, resp)
        elif path == "/api/projects":
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            self._projects_list()
        elif path == "/api/projects/branches":
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            self._project_branches()
        else:
            self._send(404, b"not found", "text/plain")

    # -- POST -------------------------------------------------------------- #
    def do_POST(self):
        if self.path == "/api/login":
            return self._login()
        if self.path == "/api/logout":
            return self._logout()
        if not self._is_authed():
            return self._json(401, {"error": "no autorizado"})
        if self.path == "/api/chat":
            return self._chat()
        if self.path == "/api/account/password":
            return self._change_password()
        if self.path == "/api/account/totp/reset":
            return self._reset_totp_web()
        if self.path == "/api/account/github-token":
            return self._set_github_token()
        if self.path == "/api/projects/clone":
            return self._project_clone()
        if self.path == "/api/projects/pull":
            return self._project_pull()
        if self.path == "/api/projects/checkout":
            return self._project_checkout()
        if self.path == "/api/projects/delete":
            return self._project_delete()
        self._json(404, {"error": "ruta desconocida"})

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return {}

    def _login(self):
        blocked = login_blocked_for()
        if blocked > 0:
            return self._json(429, {
                "error": f"demasiados intentos; espera {int(blocked)} s",
                "retry_after": int(blocked),
            })

        data = self._read_body()
        ok_pw = verify_password(str(data.get("password", "")))
        ok_code = True
        if CFG.get("totp_enabled"):
            ok_code = verify_totp(CFG["totp_secret"], str(data.get("code", "")))

        if ok_pw and ok_code:
            register_login_result(True)
            cookie = make_cookie(create_session(), session_ttl())
            self._json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie)])
        else:
            register_login_result(False)
            time.sleep(1)  # frena el goteo de intentos
            # Mensaje genérico: no revela cuál de los dos factores falló.
            self._json(403, {"error": "credenciales incorrectas"})

    def _logout(self):
        destroy_session(self._cookie_token())  # revoca en servidor
        expired = make_cookie("", 0)            # borra la cookie en el navegador
        self._json(200, {"ok": True}, extra_headers=[("Set-Cookie", expired)])

    def _change_password(self):
        """Cambia la contraseña desde el perfil web. Pide la actual. Surte
        efecto al instante (sin reinicio): actualiza CFG en memoria y disco."""
        data = self._read_body()
        cur = str(data.get("current_password", ""))
        new = str(data.get("new_password", ""))
        if not verify_password(cur):
            time.sleep(1)
            return self._json(403, {"error": "la contraseña actual no es correcta"})
        if len(new) < 8:
            return self._json(400, {"error": "la nueva contraseña debe tener al menos 8 caracteres"})
        CFG["password_hash"] = hash_password(new)
        CFG["password"] = ""              # elimina cualquier texto plano heredado
        save_config(CFG)
        clear_sessions()                  # cierra el resto de dispositivos...
        cookie = make_cookie(create_session(), session_ttl())  # ...y renueva esta sesión
        self._json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie)])

    def _reset_totp_web(self):
        """Regenera el secreto 2FA desde el perfil y devuelve el nuevo QR (SVG)
        para reinscribirlo. Pide la contraseña actual. Efecto inmediato."""
        data = self._read_body()
        if not verify_password(str(data.get("current_password", ""))):
            time.sleep(1)
            return self._json(403, {"error": "la contraseña actual no es correcta"})
        CFG["totp_secret"] = generate_totp_secret()
        CFG["totp_enabled"] = True
        save_config(CFG)
        uri = totp_uri(CFG)
        try:
            import qr
            svg = qr.render_svg(uri)
        except Exception:
            svg = ""
        self._json(200, {"ok": True, "secret": CFG["totp_secret"], "uri": uri, "svg": svg})

    def _set_github_token(self):
        """Guarda (o borra) el token de GitHub para clonar privados por HTTPS.
        Efecto inmediato. No requiere reinicio."""
        tok = str(self._read_body().get("token", "")).strip()
        CFG["github_token"] = tok
        save_config(CFG)
        self._json(200, {"ok": True, "set": bool(tok)})

    # -- proyectos (zona de desarrollo) ------------------------------------ #
    def _project_info(self, d: Path) -> dict:
        info = {"name": d.name, "git": (d / ".git").exists(),
                "branch": "", "dirty": False, "remote": "", "last": ""}
        if info["git"]:
            _, branch, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=d, timeout=15)
            _, status, _ = run_git(["status", "--porcelain"], cwd=d, timeout=15)
            _, remote, _ = run_git(["remote", "get-url", "origin"], cwd=d, timeout=15)
            _, last, _ = run_git(["log", "-1", "--pretty=%h %s"], cwd=d, timeout=15)
            info.update(branch=branch.strip(), dirty=bool(status.strip()),
                        remote=remote.strip(), last=last.strip())
        return info

    def _projects_list(self):
        items = []
        if PROJECTS.is_dir():
            for d in sorted(PROJECTS.iterdir()):
                if d.is_dir():
                    items.append(self._project_info(d))
        self._json(200, {"projects": items})

    def _project_branches(self):
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        p = project_path(q.get("name", [""])[0])
        if not p:
            return self._json(400, {"error": "proyecto no válido"})
        _, cur, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=p, timeout=15)
        _, out, _ = run_git(["branch", "-a", "--format=%(refname:short)"], cwd=p, timeout=15)
        branches = sorted({b.strip() for b in out.splitlines() if b.strip() and "HEAD" not in b})
        self._json(200, {"current": cur.strip(), "branches": branches})

    def _project_clone(self):
        data = self._read_body()
        url = str(data.get("url", "")).strip()
        if not url or not re.match(r"^(https://|git@|ssh://)", url):
            return self._json(400, {"error": "URL git no válida (usa https:// o git@…)"})
        name = str(data.get("name") or name_from_url(url))
        target = project_path(name, must_exist=False)
        if target is None:
            return self._json(400, {"error": "nombre de proyecto no válido"})
        if target.exists():
            return self._json(409, {"error": f"ya existe un proyecto '{name}'"})
        PROJECTS.mkdir(parents=True, exist_ok=True)
        code, out, err = run_git(["clone", url, name], cwd=PROJECTS, timeout=600)
        if code != 0:
            return self._json(500, {"error": (err or out or "fallo al clonar").strip()[:800]})
        self._json(200, {"ok": True, "name": name, "info": self._project_info(target)})

    def _project_pull(self):
        p = project_path(str(self._read_body().get("name", "")))
        if not p:
            return self._json(400, {"error": "proyecto no válido"})
        code, out, err = run_git(["pull", "--ff-only"], cwd=p, timeout=180)
        msg = (out + err).strip()
        if code != 0:
            return self._json(500, {"error": msg[:800] or "fallo en git pull"})
        self._json(200, {"ok": True, "output": msg[:800], "info": self._project_info(p)})

    def _project_checkout(self):
        data = self._read_body()
        p = project_path(str(data.get("name", "")))
        branch = str(data.get("branch", "")).strip()
        if not p:
            return self._json(400, {"error": "proyecto no válido"})
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", branch):
            return self._json(400, {"error": "rama no válida"})
        code, out, err = run_git(["checkout", branch], cwd=p, timeout=60)
        if code != 0:
            return self._json(500, {"error": (err or out).strip()[:800]})
        self._json(200, {"ok": True, "info": self._project_info(p)})

    def _project_delete(self):
        p = project_path(str(self._read_body().get("name", "")))
        if not p:
            return self._json(400, {"error": "proyecto no válido"})
        try:
            shutil.rmtree(p)
        except Exception as exc:
            return self._json(500, {"error": f"no se pudo borrar: {exc}"})
        self._json(200, {"ok": True})

    # -- el chat: streaming desde `claude -p` (cwd = proyecto) -------------- #
    def _chat(self):
        data = self._read_body()
        message = str(data.get("message", "")).strip()
        session_id = data.get("session_id") or None
        proj = project_path(str(data.get("project", "")))
        if proj is None:
            return self._json(400, {"error": "proyecto no válido o no seleccionado"})
        if not message:
            return self._json(400, {"error": "mensaje vacío"})

        lock = project_lock(proj.name)  # uno por proyecto -> varios en paralelo
        if not lock.acquire(blocking=False):
            return self._json(409, {"error": f"'{proj.name}' ya tiene una respuesta en curso"})

        try:
            cmd = [
                CLAUDE_BIN, "-p",
                "--output-format", "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",  # agéntico completo, sin confirmaciones
            ]
            if session_id:
                cmd += ["--resume", str(session_id)]
            if CFG.get("model"):
                cmd += ["--model", CFG["model"]]

            try:
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=str(proj),
                    text=True,
                    bufsize=1,
                )
            except FileNotFoundError:
                return self._json(500, {"error": f"no encuentro el CLI 'claude' ({CLAUDE_BIN}); "
                                                 "revisa 'claude_bin' en panel.conf o el PATH del servicio"})
            proc.stdin.write(message)
            proc.stdin.close()

            # Cabeceras de streaming (sin Content-Length -> el cierre delimita).
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")  # desactiva buffering en nginx
            self._send_security_headers()
            self.end_headers()

            def emit(ev: dict) -> bool:
                try:
                    self.wfile.write((json.dumps(ev) + "\n").encode())
                    self.wfile.flush()
                    return True
                except (BrokenPipeError, ConnectionResetError):
                    return False  # el navegador cerró: abortamos

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not self._map_event(ev, emit):
                    proc.kill()
                    break

            proc.wait()
            err = proc.stderr.read()
            if proc.returncode not in (0, None) and err:
                emit({"type": "error", "text": err.strip()[:1000]})
        finally:
            lock.release()

    @staticmethod
    def _map_event(ev: dict, emit) -> bool:
        """Traduce un evento de `claude` a algo simple para la UI. Devuelve
        False si el navegador se desconectó."""
        t = ev.get("type")
        if t == "assistant":
            for block in ev.get("message", {}).get("content", []):
                bt = block.get("type")
                if bt == "text" and block.get("text", "").strip():
                    if not emit({"type": "text", "text": block["text"]}):
                        return False
                elif bt == "tool_use":
                    if not emit({"type": "tool", "name": block.get("name", "?"),
                                 "input": block.get("input", {})}):
                        return False
        elif t == "user":
            # resultados de herramienta -> aviso compacto
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "tool_result":
                    if not emit({"type": "tool_result"}):
                        return False
        elif t == "rate_limit_event":
            info = ev.get("rate_limit_info", {})
            if info.get("status") != "allowed":
                if not emit({"type": "ratelimit", "info": info}):
                    return False
        elif t == "result":
            if not emit({
                "type": "done",
                "session_id": ev.get("session_id"),
                "cost_usd": ev.get("total_cost_usd"),
                "is_error": ev.get("is_error", False),
                "result": ev.get("result"),
            }):
                return False
        return True


def cmd_set_password() -> None:
    import getpass
    pw1 = getpass.getpass("Nueva contraseña del panel: ")
    pw2 = getpass.getpass("Repítela: ")
    if pw1 != pw2:
        print("✗ No coinciden. No se ha cambiado nada.")
        return
    if len(pw1) < 8:
        print("✗ Mínimo 8 caracteres. No se ha cambiado nada.")
        return
    CFG["password_hash"] = hash_password(pw1)
    CFG["password"] = ""  # elimina el texto plano heredado
    save_config(CFG)
    clear_sessions()      # cierra todas las sesiones abiertas
    print("✓ Contraseña actualizada (hash scrypt) y sesiones cerradas.")
    print("  Aplícalo: sudo systemctl restart claude-panel")


def cmd_reset_totp() -> None:
    CFG["totp_secret"] = generate_totp_secret()
    save_config(CFG)
    clear_sessions()
    print("✓ Nuevo secreto 2FA generado. Vuelve a inscribirlo:\n")
    print_enrollment(CFG)
    print("\n  Aplícalo: sudo systemctl restart claude-panel")


def main():
    args = sys.argv[1:]
    if "--totp" in args:            # reimprime la inscripción del 2FA y sale
        print_enrollment(CFG)
        return
    if "--set-password" in args:    # cambia la contraseña (interactivo, no la pide en claro)
        cmd_set_password()
        return
    if "--reset-totp" in args:      # regenera el secreto 2FA
        cmd_reset_totp()
        return

    if not (STATIC / "index.html").is_file():
        print(f"  ⚠ No encuentro el frontend en {STATIC}")
        print("    Clónalo/sitúalo ahí o ajusta 'staticdir' en panel.conf.")
    PROJECTS.mkdir(parents=True, exist_ok=True)  # zona de desarrollo
    httpd = ThreadingHTTPServer((CFG["host"], CFG["port"]), Handler)
    pw_mode = "hash scrypt" if CFG.get("password_hash") else f"texto plano: {CFG.get('password')}"
    print("=" * 60)
    print(f"  Panel Claude escuchando en http://{CFG['host']}:{CFG['port']}")
    print(f"  Contraseña: {pw_mode}")
    print(f"  2FA (TOTP): {'activo' if CFG.get('totp_enabled') else 'desactivado'}")
    print(f"  Frontend  : {STATIC}")
    print(f"  Proyectos : {PROJECTS}")
    print(f"  (config en {CONF_PATH})")
    print("=" * 60)
    if CFG.get("totp_enabled") and not CFG.get("password_hash"):
        print_enrollment(CFG)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
