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
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONF_PATH = BASE / "panel.conf"
LINEAR_TOKEN_PATH = BASE / "linear.token"   # token de Linear (600, fuera de git)
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


def read_linear_token() -> str:
    """Lee el token de Linear del archivo dedicado. '' si no existe/está vacío."""
    try:
        return LINEAR_TOKEN_PATH.read_text().strip()
    except FileNotFoundError:
        return ""


def save_linear_token(tok: str) -> None:
    """Escribe (o vacía) backend/linear.token con permisos 600. El secreto vive
    solo en este archivo: nunca en panel.conf, ni en git, ni se devuelve al front."""
    old = os.umask(0o077)                       # crea con permisos restrictivos
    try:
        LINEAR_TOKEN_PATH.write_text(tok or "")
    finally:
        os.umask(old)
    os.chmod(LINEAR_TOKEN_PATH, 0o600)          # 600 aunque el archivo ya existiera


LINEAR_API = "https://api.linear.app/graphql"


class LinearError(Exception):
    """Error legible para el front al hablar con Linear (sin filtrar el token)."""


def linear_query(query: str, variables: dict | None = None, timeout: int = 20) -> dict:
    """Lanza una consulta GraphQL a Linear con el token guardado (lin_api_…).
    Devuelve el bloque `data`. Lanza LinearError con un mensaje legible si algo
    falla. El token nunca se incluye en los mensajes de error."""
    tok = read_linear_token()
    if not tok:
        raise LinearError("No hay token de Linear configurado (Perfil → Linear).")
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(LINEAR_API, data=body, method="POST", headers={
        "Authorization": tok,                  # API key personal: va tal cual
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403):
            raise LinearError("Token de Linear inválido o sin permisos.")
        raise LinearError(f"Linear respondió HTTP {e.code}.")
    except urllib.error.URLError as e:
        raise LinearError(f"No se pudo conectar con Linear: {e.reason}")
    except (ValueError, TimeoutError) as e:
        raise LinearError(f"Respuesta inesperada de Linear: {e}")
    if payload.get("errors"):
        msg = "; ".join(x.get("message", "?") for x in payload["errors"])[:300]
        raise LinearError(msg or "Error de GraphQL en Linear.")
    return payload.get("data", {})


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


def safe_join(*segs, must_exist: bool = True):
    """Ruta segura a profundidad len(segs) bajo PROJECTS. None si inválida.
    Jerarquía: <cliente>/<proyecto>/<repo>."""
    if not segs or not all(valid_name(s) for s in segs):
        return None
    p = PROJECTS.joinpath(*segs).resolve()
    try:
        rel = p.relative_to(PROJECTS)
    except ValueError:
        return None
    if len(rel.parts) != len(segs):
        return None
    if must_exist and not p.is_dir():
        return None
    return p


def client_path(c, must_exist=True):
    return safe_join(c, must_exist=must_exist)


def project_path(c, p, must_exist=True):
    return safe_join(c, p, must_exist=must_exist)


def repo_path(c, p, r, must_exist=True):
    return safe_join(c, p, r, must_exist=must_exist)


def list_subdirs(base) -> list:
    return sorted(d.name for d in base.iterdir() if d.is_dir()) if base.is_dir() else []


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
# Monitorización de una segunda VPS por SSH.
#
# El panel ejecuta un recolector (bash) en la VPS remota vía SSH (clave), en una
# sola conexión, y devuelve un informe estructurado: sistema (CPU/RAM/disco),
# Docker, n8n (ejecuciones) y PostgreSQL. Los datos del host (contenedores,
# credenciales de BD) se inyectan en el script en base64 para evitar inyección
# de comandos. La lista de hosts vive en monitor.json (permisos 600).
# --------------------------------------------------------------------------- #
MON_PATH = BASE / "monitor.json"
_mon_lock = threading.Lock()


def _load_monitor() -> dict:
    try:
        d = json.loads(MON_PATH.read_text())
        if isinstance(d, dict) and isinstance(d.get("hosts"), list):
            return d
    except Exception:
        pass
    return {"hosts": []}


_monitor = _load_monitor()


def _save_monitor_locked() -> None:
    try:
        MON_PATH.write_text(json.dumps(_monitor, indent=2))
        os.chmod(MON_PATH, 0o600)
    except Exception:
        pass


def _slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", (s or "").lower()).strip("-")
    return s or "host"


def _host_public(h: dict) -> dict:
    """Versión del host sin la contraseña de BD (no sale del servidor)."""
    pub = {k: v for k, v in h.items() if k != "db_password"}
    pub["db_password_set"] = bool(h.get("db_password"))
    return pub


def ssh_run(host: dict, script: str, timeout: int = 30):
    """Ejecuta `script` (bash) en la VPS remota por SSH. Sin prompts (BatchMode):
    requiere clave autorizada. Devuelve (returncode, stdout, stderr)."""
    target = f'{host["ssh_user"]}@{host["ssh_host"]}'
    args = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
            "-p", str(host.get("ssh_port") or 22)]
    idf = host.get("identity_file")
    if idf:
        args += ["-i", os.path.expanduser(idf)]
    args += [target, "bash -s"]
    try:
        p = subprocess.run(args, input=script, capture_output=True, text=True,
                           timeout=timeout, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "tiempo de espera agotado (SSH)"
    except FileNotFoundError:
        return 127, "", "ssh no está instalado"


# Recolector remoto: imprime secciones marcadas con @@<nombre>. Los valores del
# host se inyectan en base64 (__..._B64__) y se decodifican en la VPS.
COLLECTOR_TMPL = r'''set +e
export LC_ALL=C
DBPAT="$(printf %s '__DBC_B64__' | base64 -d 2>/dev/null)"
N8PAT="$(printf %s '__N8C_B64__' | base64 -d 2>/dev/null)"
DBU="$(printf %s '__DBU_B64__' | base64 -d 2>/dev/null)"
DBN="$(printf %s '__DBN_B64__' | base64 -d 2>/dev/null)"
DBP="$(printf %s '__DBP_B64__' | base64 -d 2>/dev/null)"
N8URL="$(printf %s '__N8URL_B64__' | base64 -d 2>/dev/null)"
# Resuelve el nombre real del contenedor a partir de un prefijo de servicio
# (Docker Swarm/EasyPanel les pone sufijos aleatorios: <servicio>.<n>.<taskid>).
# Acepta también un nombre exacto. Vacío si no hay docker o no casa nada.
resolve_container() {
  [ -n "$1" ] && command -v docker >/dev/null || return 0
  docker ps --format '{{.Names}}' | grep -E "^$1(\.|\$)" | head -1
}
DBC="$(resolve_container "$DBPAT")"
N8C="$(resolve_container "$N8PAT")"
psqlq() {
  if [ -n "$DBC" ]; then
    docker exec -e PGPASSWORD="$DBP" "$DBC" psql -U "$DBU" -d "$DBN" -tAF '|' -c "$1" 2>&1
  else
    echo "sin-contenedor-db"
  fi
}
echo "@@uptime";    cat /proc/uptime 2>&1
echo "@@loadavg";   cat /proc/loadavg 2>&1
echo "@@meminfo";   cat /proc/meminfo 2>&1
echo "@@cpu1";      head -1 /proc/stat 2>&1
sleep 0.25
echo "@@cpu2";      head -1 /proc/stat 2>&1
echo "@@nproc";     nproc 2>&1
echo "@@disk";      df -P -B1 -x tmpfs -x devtmpfs 2>&1
echo "@@uname";     uname -sr 2>&1
echo "@@hostname";  hostname 2>&1
echo "@@ps";        ps -eo pid,comm,pcpu,pmem --sort=-pcpu 2>/dev/null | head -8
echo "@@docker_ps"; (command -v docker >/dev/null && docker ps -a --format '{{json .}}' 2>&1) || echo "sin-docker"
echo "@@docker_stats"; (command -v docker >/dev/null && docker stats --no-stream --format '{{json .}}' 2>&1)
echo "@@n8n_health"
if [ -n "$N8C" ]; then
  docker exec "$N8C" wget -q -S -O /dev/null http://localhost:5678/healthz 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | grep -oE '[0-9]+$' | head -1
elif [ -n "$N8URL" ]; then
  curl -s -m 5 -o /dev/null -w '%{http_code}' "$N8URL/healthz" 2>&1 || echo "err"
fi
echo "@@db_isready"; if [ -n "$DBC" ]; then docker exec "$DBC" pg_isready 2>&1; fi
echo "@@db_size";    psqlq "SELECT pg_size_pretty(pg_database_size(current_database()))"
echo "@@db_conns";   psqlq "SELECT count(*) FROM pg_stat_activity"
echo "@@db_version"; psqlq "SHOW server_version"
echo "@@n8n_exec24"; psqlq "SELECT COALESCE(status::text,'unknown') AS s, count(*) FROM execution_entity WHERE \"startedAt\" > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC"
echo "@@n8n_active"; psqlq "SELECT count(*) FROM workflow_entity WHERE active=true"
echo "@@n8n_total";  psqlq "SELECT count(*) FROM workflow_entity"
echo "@@n8n_recent"; psqlq "SELECT e.id, COALESCE(w.name,'(borrado)'), COALESCE(e.status::text, CASE WHEN e.finished THEN 'success' ELSE 'unknown' END), to_char(e.\"startedAt\",'YYYY-MM-DD HH24:MI') FROM execution_entity e LEFT JOIN workflow_entity w ON w.id::text=e.\"workflowId\"::text ORDER BY e.\"startedAt\" DESC LIMIT 10"
echo "@@end"
'''


def build_collector(h: dict) -> str:
    def b64(s):
        return base64.b64encode(str(s or "").encode()).decode()
    return (COLLECTOR_TMPL
            .replace("__DBC_B64__", b64(h.get("db_container")))
            .replace("__N8C_B64__", b64(h.get("n8n_container")))
            .replace("__DBU_B64__", b64(h.get("db_user") or "postgres"))
            .replace("__DBN_B64__", b64(h.get("db_name")))
            .replace("__DBP_B64__", b64(h.get("db_password")))
            .replace("__N8URL_B64__", b64(h.get("n8n_url") or "http://localhost:5678")))


def _split_sections(raw: str) -> dict:
    sec, cur = {}, None
    for line in raw.splitlines():
        if line.startswith("@@"):
            cur = line[2:].strip()
            sec[cur] = []
        elif cur is not None:
            sec[cur].append(line)
    return sec


def _txt(sec: dict, key: str) -> str:
    return "\n".join(sec.get(key, [])).strip()


def _psql_failed(s: str) -> bool:
    """True si la salida es un error (de psql/docker) en vez de datos."""
    if not s or s in ("sin-contenedor-db", "sin-docker"):
        return True
    markers = ["psql:", "ERROR:", "FATAL:", "could not connect", "Is the server running",
               "No such container", "Error response from daemon", "Cannot connect to the Docker",
               "does not exist", "command not found", "permission denied", "role \""]
    return any(m in s for m in markers)


def _cpu_pct(sec: dict):
    try:
        a = list(map(int, sec["cpu1"][0].split()[1:]))
        b = list(map(int, sec["cpu2"][0].split()[1:]))
        idle_a = a[3] + (a[4] if len(a) > 4 else 0)
        idle_b = b[3] + (b[4] if len(b) > 4 else 0)
        dt, di = sum(b) - sum(a), idle_b - idle_a
        return round(100.0 * (dt - di) / dt, 1) if dt > 0 else None
    except Exception:
        return None


def _mem(sec: dict) -> dict:
    d = {}
    for line in sec.get("meminfo", []):
        m = re.match(r"(\w+):\s+(\d+)", line)
        if m:
            d[m.group(1)] = int(m.group(2))  # kB
    tot = d.get("MemTotal", 0)
    avail = d.get("MemAvailable", d.get("MemFree", 0))
    used = max(0, tot - avail)
    return {"total": tot * 1024, "used": used * 1024,
            "pct": round(100.0 * used / tot, 1) if tot else None}


def _disk(sec: dict) -> list:
    out, seen = [], set()
    for line in sec.get("disk", [])[1:]:
        f = line.split()
        if len(f) < 6:
            continue
        try:
            size, used = int(f[1]), int(f[2])
        except ValueError:
            continue
        mount = " ".join(f[5:])
        if size <= 0 or mount in seen:
            continue
        seen.add(mount)
        out.append({"fs": f[0], "size": size, "used": used,
                    "pct": round(100.0 * used / size, 1) if size else 0, "mount": mount})
    out.sort(key=lambda x: -x["size"])
    return out[:8]


def _top(sec: dict) -> list:
    out = []
    for line in sec.get("ps", [])[1:]:
        f = line.split(None, 3)
        if len(f) >= 4:
            out.append({"pid": f[0], "cmd": f[1], "cpu": f[2], "mem": f[3]})
    return out


def _docker(sec: dict) -> dict:
    ps_lines = sec.get("docker_ps", [])
    if any("sin-docker" in l for l in ps_lines):
        return {"available": False, "containers": []}
    conts = {}
    for l in ps_lines:
        l = l.strip()
        if not l.startswith("{"):
            continue
        try:
            j = json.loads(l)
        except Exception:
            continue
        name = j.get("Names") or j.get("Name") or ""
        conts[name] = {"name": name, "image": j.get("Image", ""),
                       "status": j.get("Status", ""), "state": j.get("State", ""),
                       "cpu": None, "mem": None, "memusage": ""}
    for l in sec.get("docker_stats", []):
        l = l.strip()
        if not l.startswith("{"):
            continue
        try:
            j = json.loads(l)
        except Exception:
            continue
        name = j.get("Name") or j.get("Names") or ""
        if name in conts:
            conts[name]["cpu"] = j.get("CPUPerc", "")
            conts[name]["mem"] = j.get("MemPerc", "")
            conts[name]["memusage"] = j.get("MemUsage", "")
    return {"available": True, "containers": list(conts.values())}


def _n8n(sec: dict) -> dict:
    health = _txt(sec, "n8n_health")
    exec_raw = _txt(sec, "n8n_exec24")
    statuses = {}
    db_ok = not _psql_failed(exec_raw)
    if db_ok:
        for line in exec_raw.splitlines():
            p = line.split("|")
            if len(p) >= 2 and p[-1].strip().isdigit():
                statuses[(p[0].strip() or "?")] = int(p[-1])
    recent = []
    rec_raw = _txt(sec, "n8n_recent")
    if not _psql_failed(rec_raw):
        for line in rec_raw.splitlines():
            p = line.split("|")
            if len(p) >= 4:
                recent.append({"id": p[0].strip(), "workflow": p[1].strip(),
                               "status": p[2].strip(), "started": p[3].strip()})

    def num(key):
        v = _txt(sec, key)
        return int(v) if v.isdigit() else None

    return {"health": health, "health_ok": health == "200",
            "exec24": statuses, "active": num("n8n_active"),
            "total_workflows": num("n8n_total"), "recent": recent, "db_ok": db_ok}


def _db(sec: dict) -> dict:
    isready = _txt(sec, "db_isready")
    size = _txt(sec, "db_size")
    conns = _txt(sec, "db_conns")
    ver = _txt(sec, "db_version")
    return {"isready": isready,
            "ready": "accepting connections" in isready,
            "configured": isready != "" or size != "",
            "size": None if _psql_failed(size) else size,
            "conns": int(conns) if conns.isdigit() else None,
            "version": None if _psql_failed(ver) else ver}


def parse_report(raw: str, host: dict) -> dict:
    sec = _split_sections(raw)
    try:
        up = float(_txt(sec, "uptime").split()[0])
    except Exception:
        up = 0.0
    try:
        load = [float(x) for x in _txt(sec, "loadavg").split()[:3]]
    except Exception:
        load = []
    try:
        ncpu = int(_txt(sec, "nproc"))
    except Exception:
        ncpu = None
    system = {"hostname": _txt(sec, "hostname"), "kernel": _txt(sec, "uname"),
              "uptime": up, "loadavg": load, "ncpu": ncpu,
              "cpu_pct": _cpu_pct(sec), "mem": _mem(sec),
              "disk": _disk(sec), "top": _top(sec)}
    return {"system": system, "docker": _docker(sec), "n8n": _n8n(sec), "db": _db(sec)}


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
        items = extra_headers.items() if isinstance(extra_headers, dict) else (extra_headers or [])
        for k, v in items:
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
        # Sin caché: el front cambia a menudo y queremos que el navegador
        # (móvil incluido) sirva siempre la última versión tras un deploy.
        self._send(200, path.read_bytes(), ctype,
                   extra_headers={"Cache-Control": "no-cache, must-revalidate"})

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
                resp["linear_token_set"] = bool(read_linear_token())
            self._json(200, resp)
        elif path in ("/api/clients", "/api/projects", "/api/repos", "/api/repos/branches"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if path == "/api/clients":
                self._clients()
            elif path == "/api/projects":
                self._projects_of(q.get("client", [""])[0])
            elif path == "/api/repos":
                self._repos_of(q.get("client", [""])[0], q.get("project", [""])[0])
            else:
                self._repo_branches(q.get("client", [""])[0], q.get("project", [""])[0],
                                    q.get("name", [""])[0])
        elif path in ("/api/monitor/hosts", "/api/monitor/report"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if path == "/api/monitor/hosts":
                self._mon_hosts()
            else:
                self._mon_report(q.get("host", [""])[0])
        elif path in ("/api/linear/issues", "/api/linear/all"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            self._linear_issues() if path == "/api/linear/issues" else self._linear_all()
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
        if self.path == "/api/account/linear-token":
            return self._set_linear_token()
        routes = {
            "/api/clients/create": self._client_create,
            "/api/clients/delete": self._client_delete,
            "/api/clients/rename": self._client_rename,
            "/api/projects/create": self._project_create,
            "/api/projects/delete": self._project_delete,
            "/api/projects/rename": self._project_rename,
            "/api/repos/clone": self._repo_clone,
            "/api/repos/pull": self._repo_pull,
            "/api/repos/checkout": self._repo_checkout,
            "/api/repos/delete": self._repo_delete,
            "/api/repos/rename": self._repo_rename,
            "/api/monitor/hosts/save": self._mon_host_save,
            "/api/monitor/hosts/delete": self._mon_host_delete,
            "/api/monitor/test": self._mon_test,
        }
        if self.path in routes:
            return routes[self.path]()
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

    def _set_linear_token(self):
        """Guarda (o borra) el token de Linear en backend/linear.token (600).
        Efecto inmediato, sin reinicio. Nunca devuelve el token al navegador."""
        tok = str(self._read_body().get("token", "")).strip()
        save_linear_token(tok)
        self._json(200, {"ok": True, "set": bool(tok)})

    # -- Linear ------------------------------------------------------------ #
    @staticmethod
    def _li_map(n: dict, viewer_id: str = "") -> dict:
        """Normaliza un nodo issue de Linear al shape que consume el front."""
        st = n.get("state") or {}
        asg = n.get("assignee") or {}
        labels = [{"name": l.get("name", ""), "color": l.get("color", "")}
                  for l in ((n.get("labels") or {}).get("nodes") or [])]
        return {
            "id": n.get("identifier", ""),
            "title": n.get("title", ""),
            "url": n.get("url", ""),
            "priority": n.get("priority", 0),
            "priorityLabel": n.get("priorityLabel", ""),
            "updatedAt": n.get("updatedAt", ""),
            "createdAt": n.get("createdAt", ""),
            "state": st.get("name", ""),
            "stateType": st.get("type", ""),
            "stateColor": st.get("color", ""),
            "team": (n.get("team") or {}).get("key", ""),
            "project": (n.get("project") or {}).get("name", ""),
            "assignee": asg.get("displayName") or asg.get("name") or "",
            "mine": bool(viewer_id) and asg.get("id") == viewer_id,
            "labels": labels,
        }

    def _linear_issues(self):
        """Trae las incidencias asignadas a mí, sin las ya completadas/canceladas,
        ordenadas por actualización. Devuelve también nombre/email del usuario."""
        query = """
        query Mias {
          viewer {
            name
            email
            assignedIssues(
              first: 100
              orderBy: updatedAt
              filter: { state: { type: { nin: ["completed", "canceled"] } } }
            ) {
              nodes {
                identifier title url priority priorityLabel updatedAt createdAt
                state { name type color }
                assignee { id name displayName }
                team { key name }
                project { name }
                labels { nodes { name color } }
              }
            }
          }
        }
        """
        try:
            data = linear_query(query)
        except LinearError as e:
            return self._json(200, {"ok": False, "error": str(e)})
        viewer = data.get("viewer") or {}
        nodes = ((viewer.get("assignedIssues") or {}).get("nodes")) or []
        issues = [self._li_map(n) for n in nodes]
        self._json(200, {"ok": True, "user": viewer.get("name") or viewer.get("email") or "",
                         "issues": issues})

    def _linear_all(self):
        """Trae TODAS las incidencias del workspace (paginando), con su proyecto,
        estado, asignado, prioridad y etiquetas. Marca `mine` si son del usuario."""
        query = """
        query Todas($after: String) {
          viewer { id name email }
          issues(first: 250, after: $after, orderBy: updatedAt) {
            pageInfo { hasNextPage endCursor }
            nodes {
              identifier title url priority priorityLabel updatedAt createdAt
              state { name type color }
              assignee { id name displayName }
              team { key name }
              project { name }
              labels { nodes { name color } }
            }
          }
        }
        """
        issues, after, viewer = [], None, {}
        try:
            for _ in range(12):                    # tope de seguridad: 12 páginas (~3000 issues)
                data = linear_query(query, {"after": after}, timeout=30)
                viewer = data.get("viewer") or viewer
                blk = data.get("issues") or {}
                vid = viewer.get("id", "")
                issues.extend(self._li_map(n, vid) for n in (blk.get("nodes") or []))
                pi = blk.get("pageInfo") or {}
                if not pi.get("hasNextPage"):
                    break
                after = pi.get("endCursor")
        except LinearError as e:
            return self._json(200, {"ok": False, "error": str(e)})
        self._json(200, {"ok": True, "user": viewer.get("name") or viewer.get("email") or "",
                         "issues": issues})

    # -- monitorización (VPS remota por SSH) ------------------------------- #
    def _mon_hosts(self):
        with _mon_lock:
            hosts = [_host_public(h) for h in _monitor["hosts"]]
        self._json(200, {"hosts": hosts})

    def _mon_find(self, hid):
        with _mon_lock:
            return next((dict(x) for x in _monitor["hosts"] if x["id"] == hid), None)

    def _mon_host_save(self):
        d = self._read_body()
        name = str(d.get("name", "")).strip()
        ssh_user = str(d.get("ssh_user", "")).strip()
        ssh_host = str(d.get("ssh_host", "")).strip()
        if not name:
            return self._json(400, {"error": "pon un nombre"})
        if not re.fullmatch(r"[A-Za-z0-9._-]+", ssh_user or ""):
            return self._json(400, {"error": "usuario SSH no válido"})
        if not re.fullmatch(r"[A-Za-z0-9._:-]+", ssh_host or ""):
            return self._json(400, {"error": "host SSH no válido (IP o dominio)"})
        try:
            port = int(d.get("ssh_port") or 22)
        except (TypeError, ValueError):
            return self._json(400, {"error": "puerto no válido"})
        if not (1 <= port <= 65535):
            return self._json(400, {"error": "puerto fuera de rango"})
        idf = str(d.get("identity_file", "")).strip()
        if idf and not re.fullmatch(r"[A-Za-z0-9._/~-]+", idf):
            return self._json(400, {"error": "ruta de clave SSH no válida"})
        n8n_url = str(d.get("n8n_url", "")).strip()
        if n8n_url and not re.fullmatch(r"https?://[A-Za-z0-9._:/\-]+", n8n_url):
            return self._json(400, {"error": "URL de n8n no válida"})
        for fld, label in [("n8n_container", "contenedor n8n"), ("db_container", "contenedor BD"),
                           ("db_user", "usuario BD"), ("db_name", "nombre de BD")]:
            v = str(d.get(fld, "")).strip()
            if v and not re.fullmatch(r"[A-Za-z0-9._-]+", v):
                return self._json(400, {"error": f"{label} no válido"})
        hid = str(d.get("id", "")).strip() or None
        with _mon_lock:
            existing = next((h for h in _monitor["hosts"] if h["id"] == hid), None) if hid else None
            if not existing:
                base = _slug(name)
                ids = {h["id"] for h in _monitor["hosts"]}
                hid, i = base, 2
                while hid in ids:
                    hid, i = f"{base}-{i}", i + 1
                existing = {"id": hid, "db_password": ""}
                _monitor["hosts"].append(existing)
            existing.update({
                "id": hid, "name": name, "ssh_user": ssh_user, "ssh_host": ssh_host,
                "ssh_port": port, "identity_file": idf,
                "n8n_url": n8n_url or "http://localhost:5678",
                "n8n_container": str(d.get("n8n_container", "")).strip() or "n8n",
                "db_container": str(d.get("db_container", "")).strip(),
                "db_user": str(d.get("db_user", "")).strip() or "postgres",
                "db_name": str(d.get("db_name", "")).strip(),
            })
            pw = d.get("db_password")
            if isinstance(pw, str) and pw != "":
                existing["db_password"] = pw
            existing.setdefault("db_password", "")
            _save_monitor_locked()
            pub = _host_public(existing)
        self._json(200, {"ok": True, "host": pub})

    def _mon_host_delete(self):
        hid = str(self._read_body().get("id", "")).strip()
        with _mon_lock:
            n = len(_monitor["hosts"])
            _monitor["hosts"] = [h for h in _monitor["hosts"] if h["id"] != hid]
            if len(_monitor["hosts"]) != n:
                _save_monitor_locked()
        self._json(200, {"ok": True})

    def _mon_test(self):
        h = self._mon_find(str(self._read_body().get("id", "")).strip())
        if not h:
            return self._json(404, {"error": "host no encontrado"})
        script = ("echo @@host; hostname 2>&1\n"
                  "echo @@containers; (command -v docker >/dev/null && "
                  "docker ps --format '{{.Names}}|{{.Status}}' 2>&1) || echo sin-docker\n")
        code, out, err = ssh_run(h, script, timeout=20)
        if code != 0 and not out.strip():
            return self._json(200, {"ok": False, "error": (err or "fallo de conexión SSH").strip()[:400]})
        sec = _split_sections(out)
        conts = []
        for line in sec.get("containers", []):
            if "|" in line:
                nm, stt = line.split("|", 1)
                conts.append({"name": nm.strip(), "status": stt.strip()})
        self._json(200, {"ok": True, "hostname": _txt(sec, "host"), "containers": conts})

    def _mon_report(self, hid):
        h = self._mon_find(hid)
        if not h:
            return self._json(404, {"error": "host no encontrado"})
        code, out, err = ssh_run(h, build_collector(h), timeout=30)
        if code != 0 and not out.strip():
            return self._json(200, {"ok": False, "host": h["id"],
                                    "error": (err or "fallo de conexión SSH").strip()[:400]})
        rep = parse_report(out, h)
        rep.update(ok=True, host=h["id"], name=h["name"])
        if err.strip():
            rep["ssh_warn"] = err.strip()[:200]
        self._json(200, rep)

    # -- jerarquía: clientes / proyectos / repos --------------------------- #
    def _repo_info(self, d: Path) -> dict:
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

    # clientes
    def _clients(self):
        items = [{"name": c, "projects": len(list_subdirs(PROJECTS / c))}
                 for c in list_subdirs(PROJECTS)]
        self._json(200, {"clients": items})

    def _client_create(self):
        name = str(self._read_body().get("name", "")).strip()
        cp = client_path(name, must_exist=False)
        if cp is None:
            return self._json(400, {"error": "nombre de cliente no válido"})
        if cp.exists():
            return self._json(409, {"error": f"ya existe el cliente '{name}'"})
        cp.mkdir(parents=True)
        self._json(200, {"ok": True, "name": name})

    def _client_delete(self):
        cp = client_path(str(self._read_body().get("name", "")))
        if not cp:
            return self._json(400, {"error": "cliente no válido"})
        try:
            shutil.rmtree(cp)
        except Exception as exc:
            return self._json(500, {"error": f"no se pudo borrar: {exc}"})
        self._json(200, {"ok": True})

    def _rename_dir(self, old, new):
        if not old:
            return self._json(400, {"error": "origen no válido"})
        if new is None:
            return self._json(400, {"error": "nombre nuevo no válido"})
        if new.exists():
            return self._json(409, {"error": "ya existe algo con ese nombre"})
        try:
            old.rename(new)
        except Exception as exc:
            return self._json(500, {"error": f"no se pudo renombrar: {exc}"})
        self._json(200, {"ok": True, "name": new.name})

    def _client_rename(self):
        data = self._read_body()
        self._rename_dir(client_path(str(data.get("name", ""))),
                         client_path(str(data.get("new_name", "")), must_exist=False))

    # proyectos (dentro de un cliente)
    def _projects_of(self, client):
        cp = client_path(client)
        if not cp:
            return self._json(400, {"error": "cliente no válido"})
        items = [{"name": p, "repos": len(list_subdirs(cp / p))} for p in list_subdirs(cp)]
        self._json(200, {"projects": items})

    def _project_create(self):
        data = self._read_body()
        cp = client_path(str(data.get("client", "")))
        if not cp:
            return self._json(400, {"error": "cliente no válido"})
        name = str(data.get("name", "")).strip()
        pp = project_path(cp.name, name, must_exist=False)
        if pp is None:
            return self._json(400, {"error": "nombre de proyecto no válido"})
        if pp.exists():
            return self._json(409, {"error": f"ya existe el proyecto '{name}'"})
        pp.mkdir(parents=True)
        self._json(200, {"ok": True, "name": name})

    def _project_delete(self):
        data = self._read_body()
        pp = project_path(str(data.get("client", "")), str(data.get("name", "")))
        if not pp:
            return self._json(400, {"error": "proyecto no válido"})
        try:
            shutil.rmtree(pp)
        except Exception as exc:
            return self._json(500, {"error": f"no se pudo borrar: {exc}"})
        self._json(200, {"ok": True})

    def _project_rename(self):
        data = self._read_body()
        c = str(data.get("client", ""))
        self._rename_dir(project_path(c, str(data.get("name", ""))),
                         project_path(c, str(data.get("new_name", "")), must_exist=False))

    # repos (dentro de cliente/proyecto)
    def _repos_of(self, client, project):
        pp = project_path(client, project)
        if not pp:
            return self._json(400, {"error": "ruta no válida"})
        items = [self._repo_info(pp / r) for r in list_subdirs(pp)]
        self._json(200, {"repos": items})

    def _repo_branches(self, client, project, name):
        rp = repo_path(client, project, name)
        if not rp:
            return self._json(400, {"error": "repo no válido"})
        _, cur, _ = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=rp, timeout=15)
        _, out, _ = run_git(["branch", "-a", "--format=%(refname:short)"], cwd=rp, timeout=15)
        branches = sorted({b.strip() for b in out.splitlines() if b.strip() and "HEAD" not in b})
        self._json(200, {"current": cur.strip(), "branches": branches})

    def _repo_clone(self):
        data = self._read_body()
        pp = project_path(str(data.get("client", "")), str(data.get("project", "")))
        if not pp:
            return self._json(400, {"error": "cliente/proyecto no válido"})
        url = str(data.get("url", "")).strip()
        if not url or not re.match(r"^(https://|git@|ssh://)", url):
            return self._json(400, {"error": "URL git no válida (usa https:// o git@…)"})
        name = str(data.get("name") or name_from_url(url))
        target = repo_path(pp.parent.name, pp.name, name, must_exist=False)
        if target is None:
            return self._json(400, {"error": "nombre de repo no válido"})
        if target.exists():
            return self._json(409, {"error": f"ya existe un repo '{name}'"})
        code, out, err = run_git(["clone", url, name], cwd=pp, timeout=600)
        if code != 0:
            return self._json(500, {"error": (err or out or "fallo al clonar").strip()[:800]})
        self._json(200, {"ok": True, "name": name, "info": self._repo_info(target)})

    def _repo_pull(self):
        data = self._read_body()
        rp = repo_path(str(data.get("client", "")), str(data.get("project", "")), str(data.get("name", "")))
        if not rp:
            return self._json(400, {"error": "repo no válido"})
        code, out, err = run_git(["pull", "--ff-only"], cwd=rp, timeout=180)
        msg = (out + err).strip()
        if code != 0:
            return self._json(500, {"error": msg[:800] or "fallo en git pull"})
        self._json(200, {"ok": True, "output": msg[:800], "info": self._repo_info(rp)})

    def _repo_checkout(self):
        data = self._read_body()
        rp = repo_path(str(data.get("client", "")), str(data.get("project", "")), str(data.get("name", "")))
        branch = str(data.get("branch", "")).strip()
        if not rp:
            return self._json(400, {"error": "repo no válido"})
        if not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", branch):
            return self._json(400, {"error": "rama no válida"})
        code, out, err = run_git(["checkout", branch], cwd=rp, timeout=60)
        if code != 0:
            return self._json(500, {"error": (err or out).strip()[:800]})
        self._json(200, {"ok": True, "info": self._repo_info(rp)})

    def _repo_delete(self):
        data = self._read_body()
        rp = repo_path(str(data.get("client", "")), str(data.get("project", "")), str(data.get("name", "")))
        if not rp:
            return self._json(400, {"error": "repo no válido"})
        try:
            shutil.rmtree(rp)
        except Exception as exc:
            return self._json(500, {"error": f"no se pudo borrar: {exc}"})
        self._json(200, {"ok": True})

    def _repo_rename(self):
        data = self._read_body()
        c, p = str(data.get("client", "")), str(data.get("project", ""))
        self._rename_dir(repo_path(c, p, str(data.get("name", ""))),
                         repo_path(c, p, str(data.get("new_name", "")), must_exist=False))

    # -- el chat: streaming desde `claude -p` (cwd = repo) ----------------- #
    def _chat(self):
        data = self._read_body()
        message = str(data.get("message", "")).strip()
        session_id = data.get("session_id") or None
        proj = repo_path(str(data.get("client", "")), str(data.get("project", "")),
                         str(data.get("repo", "")))
        if proj is None:
            return self._json(400, {"error": "repo no válido o no seleccionado"})
        if not message:
            return self._json(400, {"error": "mensaje vacío"})

        key = str(proj.relative_to(PROJECTS))   # cliente/proyecto/repo
        lock = project_lock(key)                # uno por repo -> varios en paralelo
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
