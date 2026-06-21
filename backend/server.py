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
    if changed or not CONF_PATH.exists():
        CONF_PATH.write_text(json.dumps(cfg, indent=2))
        os.chmod(CONF_PATH, 0o600)
    return cfg


CFG = load_config()
STATIC = Path(CFG["staticdir"]).resolve()

# Solo una conversación de Claude a la vez (es un panel personal).
_chat_lock = threading.Lock()

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


def auth_token() -> str:
    return hmac.new(CFG["secret"].encode(), b"authed", hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- #
# Handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # cierre de conexión delimita el streaming
    server_version = "ClaudePanel/1"

    def log_message(self, fmt, *args):  # logging compacto
        print(f"{self.address_string()} {fmt % args}")

    # -- helpers ----------------------------------------------------------- #
    def _is_authed(self) -> bool:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("auth")
        return bool(morsel) and hmac.compare_digest(morsel.value, auth_token())

    def _send(self, code: int, body: bytes, ctype: str, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
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
        if self.path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif self.path.startswith("/static/"):
            self._serve_static(self.path[len("/static/") :])
        elif self.path == "/api/whoami":
            self._json(200, {"authed": self._is_authed(),
                             "totp": bool(CFG.get("totp_enabled"))})
        else:
            self._send(404, b"not found", "text/plain")

    # -- POST -------------------------------------------------------------- #
    def do_POST(self):
        if self.path == "/api/login":
            return self._login()
        if not self._is_authed():
            return self._json(401, {"error": "no autorizado"})
        if self.path == "/api/chat":
            return self._chat()
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
        ok_pw = hmac.compare_digest(str(data.get("password", "")), CFG["password"])
        ok_code = True
        if CFG.get("totp_enabled"):
            ok_code = verify_totp(CFG["totp_secret"], str(data.get("code", "")))

        if ok_pw and ok_code:
            register_login_result(True)
            cookie = f"auth={auth_token()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000"
            self._json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie)])
        else:
            register_login_result(False)
            time.sleep(1)  # frena el goteo de intentos
            # Mensaje genérico: no revela cuál de los dos factores falló.
            self._json(403, {"error": "credenciales incorrectas"})

    # -- el chat: streaming desde `claude -p` ------------------------------ #
    def _chat(self):
        data = self._read_body()
        message = str(data.get("message", "")).strip()
        session_id = data.get("session_id") or None
        if not message:
            return self._json(400, {"error": "mensaje vacío"})

        if not _chat_lock.acquire(blocking=False):
            return self._json(409, {"error": "ocupado: ya hay una respuesta en curso"})

        try:
            cmd = [
                "claude", "-p",
                "--output-format", "stream-json",
                "--verbose",
                "--dangerously-skip-permissions",  # agéntico completo, sin confirmaciones
            ]
            if session_id:
                cmd += ["--resume", str(session_id)]
            if CFG.get("model"):
                cmd += ["--model", CFG["model"]]

            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=CFG["workdir"],
                text=True,
                bufsize=1,
            )
            proc.stdin.write(message)
            proc.stdin.close()

            # Cabeceras de streaming (sin Content-Length -> el cierre delimita).
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")  # desactiva buffering en nginx
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
            _chat_lock.release()

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


def main():
    # `python3 server.py --totp` reimprime la inscripción del 2FA y sale.
    if "--totp" in sys.argv[1:]:
        print_enrollment(CFG)
        return

    if not (STATIC / "index.html").is_file():
        print(f"  ⚠ No encuentro el frontend en {STATIC}")
        print("    Clónalo/sitúalo ahí o ajusta 'staticdir' en panel.conf.")
    httpd = ThreadingHTTPServer((CFG["host"], CFG["port"]), Handler)
    print("=" * 60)
    print(f"  Panel Claude escuchando en http://{CFG['host']}:{CFG['port']}")
    print(f"  Contraseña: {CFG['password']}")
    print(f"  2FA (TOTP): {'activo' if CFG.get('totp_enabled') else 'desactivado'}")
    print(f"  Frontend  : {STATIC}")
    print(f"  Workdir   : {CFG['workdir']}")
    print(f"  (config en {CONF_PATH})")
    print("=" * 60)
    if CFG.get("totp_enabled"):
        print_enrollment(CFG)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
