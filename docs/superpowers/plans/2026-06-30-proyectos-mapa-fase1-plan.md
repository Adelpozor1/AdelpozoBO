# Proyectos + Mapa de plataforma — Fase 1 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renombrar la pestaña "Desarrollo" a "Proyectos", introducir metadata por proyecto en disco (`.panel.json` + `.linear.token`), añadir endpoints para gestionar esa metadata y un editor "Mapa" como sub-pestaña dentro de cada proyecto que permita capturar servicios (zonas) y conexiones (cables) en un formulario plano, además de contextualizar la pestaña Linear del header al proyecto activo. **Sin 3D, sin nueva ingesta de monitor.**

**Architecture:** Monolito Python stdlib (`backend/server.py`) + frontend vanilla (`frontend/{index.html, app.js, styles.css}`). Sin nuevas dependencias en backend ni frontend. Metadata por proyecto en archivos `.panel.json` + `.linear.token` dentro de `projects_dir/<cliente>/<proyecto>/`, permisos `600`, jamás devueltos al cliente excepto el `.panel.json` ya filtrado (sin token). Reusa `valid_name`, `safe_join`, `project_lock` y los patrones existentes de endpoints/handlers.

**Tech Stack:** Python 3 (solo stdlib: `json`, `secrets`, `pathlib`, `urllib`, `http.server`), HTML5 + CSS3 + JavaScript vanilla (sin frameworks, sin build).

**Spec de referencia:** `docs/superpowers/specs/2026-06-30-proyectos-mapa-fase1-design.md`

**Política de commits para esta fase:** **Un único commit al final** (Task 14) que incluya el spec, el plan y el código. Cada task tiene un "Checkpoint" en lugar de "Commit": verificación manual antes de pasar a la siguiente.

---

## File structure

**Modificados:**

- `frontend/index.html` — rename del botón header; wrapping del contenido de `#main-row` en `#repos-area`; nuevo `#map-area` + barra `.proj-tabs`; modales `#svcModal`, `#connModal`, `#linTokenModal`.
- `frontend/app.js` — variables de estado `mapState`/`mapLoaded`/`mapDirty`; funciones `loadMeta`, `renderMap`, modales de servicio/conexión/token; `enterMapTab`/`enterReposTab`; refactor de `linearEnter` para usar endpoints contextuales.
- `frontend/styles.css` — actualizar comentario de pestañas; estilos para `.proj-tabs`, editor (`.svc-row`, `.conn-row`, `.svc-kind-badge`, etc.) y los 3 modales nuevos (reusa el patrón existente de modales).
- `backend/server.py` — nuevos helpers (`PROJECT_META_NAME`, `PROJECT_LINEAR_NAME`, `SVC_KINDS`, `MAX_SERVICES`, `MAX_CONNECTIONS`, `meta_path`, `linear_token_path`, `load_project_meta`, `save_project_meta`, `read_project_linear_token`, `save_project_linear_token`, `assign_id`, `validate_meta_payload`); refactor de `linear_query()` para aceptar `token` opcional; cinco endpoints nuevos (`_proj_meta_get`, `_proj_meta_save`, `_proj_linear_token_save`, `_proj_linear_issues`, `_proj_linear_all`) wireados en `do_GET`/`do_POST`.
- `AdelpozoBO/.gitignore` — añadir `*.panel.json` y `*.linear.token` (aunque `projects_dir` vive fuera del repo del panel, esto cubre el caso de que alguien clone dentro).

**Creados:** ninguno.

---

## Task 1: Setup — sandbox local + .gitignore

**Files:**
- Modify: `AdelpozoBO/.gitignore`
- Sandbox local (no en repo): `panel.conf` apunta ya a `projects_dir = /private/tmp/.../scratchpad/panel-projects` (de turnos anteriores). Si no existe, se crea solo cuando arranque el server.

- [ ] **Step 1: Leer `.gitignore` actual**

Run:
```bash
cat "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/.gitignore"
```
Expected: lista de patrones existentes (panel.conf, sessions.json, linear.token, etc.).

- [ ] **Step 2: Añadir patrones para los nuevos archivos por proyecto**

Editar `AdelpozoBO/.gitignore` y añadir al final (si no están ya):

```gitignore

# Metadata por proyecto (Fase 1)
*.panel.json
*.linear.token
```

- [ ] **Step 3: Verificar**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git status --short
```
Expected: el `.gitignore` modificado aparece como `M .gitignore`. No aparecen `.panel.json` ni `.linear.token` como untracked.

- [ ] **Step 4: Crear sandbox client/project para verificación**

Run:
```bash
mkdir -p "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project"
ls -la "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project"
```
Expected: el directorio existe (vacío). Lo usaremos en los checkpoints siguientes para `curl` contra el backend.

- [ ] **Step 5: Checkpoint** — `.gitignore` actualizado y sandbox listo. Sin commit.

---

## Task 2: Backend — helpers de metadata + token Linear por proyecto + refactor `linear_query`

**Files:**
- Modify: `backend/server.py` (añadir helpers tras `repo_path` ~ línea 309 y refactor de `linear_query` línea 194)

- [ ] **Step 1: Añadir constantes y helpers de paths**

Editar `backend/server.py`. **Tras la función `repo_path` (alrededor de la línea 309)**, añadir:

```python
# --------------------------------------------------------------------------- #
# Metadata por proyecto (Fase 1: servicios, conexiones, token Linear).
# Cada proyecto guarda dos archivos en projects_dir/<cliente>/<proyecto>/:
#   .panel.json   → config no-secreta (servicios + conexiones), permisos 600
#   .linear.token → token de Linear del proyecto, permisos 600 (nunca en API)
# --------------------------------------------------------------------------- #
PROJECT_META_NAME = ".panel.json"
PROJECT_LINEAR_TOKEN_NAME = ".linear.token"

SVC_KINDS = ("vps", "n8n", "docker", "chatwoot", "postgres", "github", "linear", "custom")
MAX_SERVICES = 100
MAX_CONNECTIONS = 500
MAX_NAME_LEN = 100
MAX_LABEL_LEN = 80


def meta_path(c: str, p: str) -> Path | None:
    """Ruta al .panel.json de un proyecto. Devuelve None si <c>/<p> no es válido
    o no existe. La validación delega en safe_join (path traversal-safe)."""
    base = safe_join(c, p)
    return None if base is None else base / PROJECT_META_NAME


def linear_token_path(c: str, p: str) -> Path | None:
    """Ruta al .linear.token de un proyecto. Misma validación que meta_path."""
    base = safe_join(c, p)
    return None if base is None else base / PROJECT_LINEAR_TOKEN_NAME


def load_project_meta(c: str, p: str) -> dict:
    """Lee el .panel.json del proyecto. Si no existe → estado vacío. Si está
    corrupto → lanza ValueError (el caller debe devolver 500 al cliente)."""
    mp = meta_path(c, p)
    if mp is None or not mp.exists():
        return {"version": 1, "services": [], "connections": []}
    try:
        data = json.loads(mp.read_text())
    except json.JSONDecodeError as e:
        raise ValueError(f"{PROJECT_META_NAME} corrupto: {e}")
    # normaliza por si falta algún campo top-level
    data.setdefault("version", 1)
    data.setdefault("services", [])
    data.setdefault("connections", [])
    return data


def save_project_meta(c: str, p: str, data: dict) -> None:
    """Escribe el .panel.json con permisos 600. Atomicidad simple: escribe a
    tmp + rename. Asume que data ya está validada por validate_meta_payload."""
    mp = meta_path(c, p)
    if mp is None:
        raise ValueError("ruta de proyecto inválida")
    payload = json.dumps(data, indent=2, ensure_ascii=False).encode()
    tmp = mp.with_suffix(mp.suffix + ".tmp")
    old = os.umask(0o077)
    try:
        tmp.write_bytes(payload)
        os.chmod(tmp, 0o600)
        tmp.replace(mp)            # rename atómico en POSIX
    finally:
        os.umask(old)


def read_project_linear_token(c: str, p: str) -> str:
    """Lee el token Linear del proyecto. '' si no existe / vacío / ruta inválida."""
    tp = linear_token_path(c, p)
    if tp is None:
        return ""
    try:
        return tp.read_text().strip()
    except FileNotFoundError:
        return ""


def save_project_linear_token(c: str, p: str, tok: str) -> None:
    """Escribe (o borra) el token Linear del proyecto con permisos 600.
    Si tok es vacío, borra el archivo (estado «no configurado»)."""
    tp = linear_token_path(c, p)
    if tp is None:
        raise ValueError("ruta de proyecto inválida")
    if not tok:
        try:
            tp.unlink()
        except FileNotFoundError:
            pass
        return
    old = os.umask(0o077)
    try:
        tp.write_text(tok)
    finally:
        os.umask(old)
    os.chmod(tp, 0o600)


def _new_id(prefix: str) -> str:
    """ID corto para servicios/conexiones (4 hex = 16 bits, suficiente para
    los caps de Fase 1: ≤100 servicios, ≤500 conexiones)."""
    return f"{prefix}-{secrets.token_hex(2)}"


def validate_meta_payload(payload: dict) -> tuple[dict | None, str]:
    """Valida y normaliza un payload entrante para POST /api/projects/meta.
    Devuelve (data_normalizada, "") en éxito o (None, "mensaje de error").
    Asigna ids a servicios/conexiones que no los traen. Detecta colisiones,
    referencias rotas y caps superados."""
    if not isinstance(payload, dict):
        return None, "payload debe ser objeto JSON"
    services = payload.get("services") or []
    connections = payload.get("connections") or []
    if not isinstance(services, list) or not isinstance(connections, list):
        return None, "services y connections deben ser arrays"
    if len(services) > MAX_SERVICES:
        return None, f"máximo {MAX_SERVICES} servicios por proyecto"
    if len(connections) > MAX_CONNECTIONS:
        return None, f"máximo {MAX_CONNECTIONS} conexiones por proyecto"

    seen_svc_ids: set[str] = set()
    out_services: list[dict] = []
    for i, s in enumerate(services):
        if not isinstance(s, dict):
            return None, f"servicio {i}: debe ser objeto"
        kind = s.get("kind", "")
        if kind not in SVC_KINDS:
            return None, f"servicio {i}: kind '{kind}' no válido"
        name = s.get("name", "")
        if not isinstance(name, str) or not name.strip():
            return None, f"servicio {i}: name vacío"
        if len(name) > MAX_NAME_LEN:
            return None, f"servicio {i}: name excede {MAX_NAME_LEN} caracteres"
        cfg = s.get("config")
        if cfg is not None and not isinstance(cfg, dict):
            return None, f"servicio {i}: config debe ser objeto o null"
        sid = s.get("id") or _new_id(kind)
        if sid in seen_svc_ids:
            return None, f"servicio {i}: id duplicado '{sid}'"
        seen_svc_ids.add(sid)
        out_services.append({
            "id": sid, "kind": kind, "name": name.strip(),
            "config": cfg if cfg is not None else {},
        })

    seen_conn_ids: set[str] = set()
    out_connections: list[dict] = []
    for i, ce in enumerate(connections):
        if not isinstance(ce, dict):
            return None, f"conexión {i}: debe ser objeto"
        f, t = ce.get("from", ""), ce.get("to", "")
        if f not in seen_svc_ids:
            return None, f"conexión {i}: from '{f}' no es un servicio del proyecto"
        if t not in seen_svc_ids:
            return None, f"conexión {i}: to '{t}' no es un servicio del proyecto"
        label = ce.get("label", "")
        if not isinstance(label, str):
            return None, f"conexión {i}: label debe ser string"
        if len(label) > MAX_LABEL_LEN:
            return None, f"conexión {i}: label excede {MAX_LABEL_LEN} caracteres"
        cid = ce.get("id") or _new_id("c")
        if cid in seen_conn_ids:
            return None, f"conexión {i}: id duplicado '{cid}'"
        seen_conn_ids.add(cid)
        out_connections.append({"id": cid, "from": f, "to": t, "label": label})

    return {"version": 1, "services": out_services, "connections": out_connections}, ""
```

- [ ] **Step 2: Refactor de `linear_query` para aceptar token opcional**

Editar `backend/server.py` línea ~194. **Reemplazar** la función completa por:

```python
def linear_query(query: str, variables: dict | None = None, timeout: int = 20,
                 token: str = "") -> dict:
    """Lanza una consulta GraphQL a Linear. Si `token` no se pasa, usa el token
    global (backend/linear.token). Devuelve el bloque `data`. Lanza LinearError
    con un mensaje legible si algo falla. El token nunca se incluye en errores."""
    tok = token or read_linear_token()
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
```

(Único cambio respecto al original: nuevo parámetro `token: str = ""` y `tok = token or read_linear_token()` en lugar de `tok = read_linear_token()`. Cero breaking change para los callers existentes.)

- [ ] **Step 3: Smoke test del módulo — import y helpers básicos**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 -c "
import server
# Sanidad de los helpers nuevos
print('SVC_KINDS:', server.SVC_KINDS)
print('MAX_SERVICES:', server.MAX_SERVICES)
mp = server.meta_path('test-client', 'test-project')
print('meta_path:', mp)
print('exists:', mp.exists() if mp else None)
# Carga vacía no debe romper
print('empty meta:', server.load_project_meta('test-client', 'test-project'))
# Validación: payload OK
ok, err = server.validate_meta_payload({
    'services': [{'kind': 'vps', 'name': 'V1', 'config': {'host': '1.2.3.4'}}],
    'connections': []
})
print('valid:', ok, 'err:', err)
# Validación: kind inválido
ok, err = server.validate_meta_payload({'services':[{'kind':'lol','name':'x'}],'connections':[]})
print('invalid kind err:', err)
"
```
Expected output:
```
SVC_KINDS: ('vps', 'n8n', 'docker', 'chatwoot', 'postgres', 'github', 'linear', 'custom')
MAX_SERVICES: 100
meta_path: /private/tmp/.../scratchpad/panel-projects/test-client/test-project/.panel.json
exists: False
empty meta: {'version': 1, 'services': [], 'connections': []}
valid: {'version': 1, 'services': [{'id': 'vps-xxxx', ...}], 'connections': []} err:
invalid kind err: servicio 0: kind 'lol' no válido
```

- [ ] **Step 4: Checkpoint** — Helpers cargan, validan y normalizan correctamente.

---

## Task 3: Backend — Endpoint `GET /api/projects/meta`

**Files:**
- Modify: `backend/server.py` (handler nuevo en la clase `Handler`, antes de `# -- monitorización` ~ línea 1091; ruta wireada en `do_GET` ~ línea 840)

- [ ] **Step 1: Añadir el handler `_proj_meta_get`**

Editar `backend/server.py`. **Antes de la línea `# -- monitorización (VPS remota por SSH) ---`** (sobre la línea 1091), añadir:

```python
    # -- proyectos: metadata (Fase 1) -------------------------------------- #
    def _proj_meta_get(self, c: str, p: str):
        """Devuelve la metadata del proyecto (servicios + conexiones) y el
        estado del token Linear. NUNCA devuelve el token en sí."""
        if not valid_name(c) or not valid_name(p):
            return self._json(400, {"error": "nombres no válidos"})
        if safe_join(c, p) is None:
            return self._json(404, {"error": "proyecto no existe"})
        try:
            with project_lock(f"{c}/{p}"):
                data = load_project_meta(c, p)
                has_proj = bool(read_project_linear_token(c, p))
        except ValueError as e:
            return self._json(500, {"error": str(e)})
        has_global = bool(read_linear_token())
        self._json(200, {
            "services": data.get("services", []),
            "connections": data.get("connections", []),
            "linear_status": {
                "has_project_token": has_proj,
                "has_global_fallback": has_global,
            },
        })
```

- [ ] **Step 2: Wirear la ruta en `do_GET`**

Editar `backend/server.py` ~ línea 840. **Reemplazar** el bloque:

```python
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
```

por:

```python
        elif path in ("/api/clients", "/api/projects", "/api/repos",
                      "/api/repos/branches", "/api/projects/meta"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            if path == "/api/clients":
                self._clients()
            elif path == "/api/projects":
                self._projects_of(q.get("client", [""])[0])
            elif path == "/api/repos":
                self._repos_of(q.get("client", [""])[0], q.get("project", [""])[0])
            elif path == "/api/projects/meta":
                self._proj_meta_get(q.get("client", [""])[0], q.get("project", [""])[0])
            else:
                self._repo_branches(q.get("client", [""])[0], q.get("project", [""])[0],
                                    q.get("name", [""])[0])
```

- [ ] **Step 3: Arrancar server y probar con curl**

Run (en background; mata cualquier instancia previa primero):

```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
```

Login para obtener cookie de sesión (usa la contraseña autogenerada `uqTFZdDp5YOHPj8N` y guarda la cookie en `/tmp/panel-cookie`):

```bash
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"uqTFZdDp5YOHPj8N"}'
```
Expected: `{"ok": true}`

GET de metadata (proyecto vacío del Task 1):

```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=test-client&project=test-project" | python3 -m json.tool
```
Expected:
```json
{
    "services": [],
    "connections": [],
    "linear_status": {
        "has_project_token": false,
        "has_global_fallback": false
    }
}
```

Path traversal blocked:

```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=../foo&project=test-project"
```
Expected: `{"error": "nombres no válidos"}`

Proyecto inexistente:

```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=nope&project=nope"
```
Expected: `{"error": "proyecto no existe"}`

- [ ] **Step 4: Checkpoint** — GET funciona, validaciones bloquean, server sigue vivo.

---

## Task 4: Backend — Endpoint `POST /api/projects/meta`

**Files:**
- Modify: `backend/server.py` (handler `_proj_meta_save` junto al GET; ruta en `do_POST` dispatch ~ línea 886)

- [ ] **Step 1: Añadir handler `_proj_meta_save`**

Editar `backend/server.py`. **Justo después del handler `_proj_meta_get`** añadido en Task 3, añadir:

```python
    def _proj_meta_save(self):
        """Reemplaza la metadata del proyecto entera (servicios + conexiones).
        Asigna ids a entries nuevas, valida tipos/cap/referencias. NO toca el
        token Linear (eso va por su endpoint dedicado)."""
        d = self._read_body()
        c = str(d.get("client", "")).strip()
        p = str(d.get("project", "")).strip()
        if not valid_name(c) or not valid_name(p):
            return self._json(400, {"error": "nombres no válidos"})
        if safe_join(c, p) is None:
            return self._json(404, {"error": "proyecto no existe"})
        normalized, err = validate_meta_payload(d)
        if normalized is None:
            return self._json(400, {"error": err})
        try:
            with project_lock(f"{c}/{p}"):
                save_project_meta(c, p, normalized)
                has_proj = bool(read_project_linear_token(c, p))
        except ValueError as e:
            return self._json(500, {"error": str(e)})
        print(f"[meta] save {c}/{p}: {len(normalized['services'])} svc, "
              f"{len(normalized['connections'])} conn")
        has_global = bool(read_linear_token())
        self._json(200, {
            "services": normalized["services"],
            "connections": normalized["connections"],
            "linear_status": {
                "has_project_token": has_proj,
                "has_global_fallback": has_global,
            },
        })
```

- [ ] **Step 2: Wirear la ruta en `do_POST`**

Editar `backend/server.py` ~ línea 886. En el dict `routes`, añadir la nueva entrada (al lado de `/api/projects/...`):

```python
        routes = {
            "/api/clients/create": self._client_create,
            "/api/clients/delete": self._client_delete,
            "/api/clients/rename": self._client_rename,
            "/api/projects/create": self._project_create,
            "/api/projects/delete": self._project_delete,
            "/api/projects/rename": self._project_rename,
            "/api/projects/meta": self._proj_meta_save,
            "/api/repos/clone": self._repo_clone,
            "/api/repos/pull": self._repo_pull,
            "/api/repos/checkout": self._repo_checkout,
            "/api/repos/delete": self._repo_delete,
            "/api/repos/rename": self._repo_rename,
            "/api/monitor/hosts/save": self._mon_host_save,
            "/api/monitor/hosts/delete": self._mon_host_delete,
            "/api/monitor/test": self._mon_test,
        }
```

(Línea añadida: `"/api/projects/meta": self._proj_meta_save,`)

- [ ] **Step 3: Reiniciar server y probar**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
```

POST happy path:

```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{
    "client":"test-client","project":"test-project",
    "services":[
      {"kind":"vps","name":"VPS principal","config":{"host":"1.2.3.4","user":"ubuntu"}},
      {"kind":"n8n","name":"n8n cliente X","config":{"container":"n8n_prod"}}
    ],
    "connections":[]
  }' | python3 -m json.tool
```
Expected: respuesta con `services` que tienen `id` asignado (p. ej. `vps-XXXX`, `n8n-XXXX`), `connections: []`, `linear_status` con flags.

Verificar archivo en disco con permisos correctos:

```bash
ls -la "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project/.panel.json"
cat "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project/.panel.json"
```
Expected: archivo con permisos `-rw-------`, JSON con servicios + ids.

Validación: kind fuera del enum →
```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d '{"client":"test-client","project":"test-project","services":[{"kind":"x","name":"y"}],"connections":[]}'
```
Expected: `{"error": "servicio 0: kind 'x' no válido"}`

Validación: conexión a id inexistente. Primero captura el id real de un servicio y mete una conexión rota:

```bash
SID=$(curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=test-client&project=test-project" | python3 -c "import json,sys; print(json.load(sys.stdin)['services'][0]['id'])")
echo "SID=$SID"
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/meta \
  -H "Content-Type: application/json" \
  -d "{\"client\":\"test-client\",\"project\":\"test-project\",\"services\":[{\"id\":\"$SID\",\"kind\":\"vps\",\"name\":\"V\"}],\"connections\":[{\"from\":\"$SID\",\"to\":\"nope-9999\",\"label\":\"x\"}]}"
```
Expected: `{"error": "conexión 0: to 'nope-9999' no es un servicio del proyecto"}`

- [ ] **Step 4: Checkpoint** — POST guarda, valida y persiste con permisos correctos.

---

## Task 5: Backend — Endpoints Linear por proyecto (token + issues + all)

**Files:**
- Modify: `backend/server.py` (3 handlers nuevos junto a los de Task 3-4; rutas en `do_POST` y `do_GET`)

- [ ] **Step 1: Añadir handler `_proj_linear_token_save`**

Editar `backend/server.py`. **Justo después de `_proj_meta_save`** (Task 4), añadir:

```python
    def _proj_linear_token_save(self):
        """Guarda (o borra si vacío) el token de Linear del proyecto. Nunca
        devuelve el token. Permisos 600."""
        d = self._read_body()
        c = str(d.get("client", "")).strip()
        p = str(d.get("project", "")).strip()
        if not valid_name(c) or not valid_name(p):
            return self._json(400, {"error": "nombres no válidos"})
        if safe_join(c, p) is None:
            return self._json(404, {"error": "proyecto no existe"})
        tok = str(d.get("token", "")).strip()
        try:
            with project_lock(f"{c}/{p}"):
                save_project_linear_token(c, p, tok)
        except ValueError as e:
            return self._json(500, {"error": str(e)})
        print(f"[linear-token] {'set' if tok else 'cleared'} {c}/{p}")
        self._json(200, {"ok": True, "set": bool(tok)})
```

- [ ] **Step 2: Añadir resolver de token + 2 handlers de issues**

Editar `backend/server.py`. **Justo después de `_proj_linear_token_save`** añadir:

```python
    def _resolve_linear_token(self, c: str, p: str) -> tuple[str, str]:
        """Devuelve (token, source) donde source ∈ {"project", "global", ""}.
        Aplica la política de fallback: project > global > ninguno."""
        proj_tok = read_project_linear_token(c, p)
        if proj_tok:
            return proj_tok, "project"
        glob = read_linear_token()
        if glob:
            return glob, "global"
        return "", ""

    def _proj_linear_issues(self, c: str, p: str):
        """Versión contextual de _linear_issues: usa el token del proyecto (o
        fallback al global). Mismo shape de respuesta, más `source`."""
        if not valid_name(c) or not valid_name(p):
            return self._json(400, {"error": "nombres no válidos"})
        if safe_join(c, p) is None:
            return self._json(404, {"error": "proyecto no existe"})
        tok, source = self._resolve_linear_token(c, p)
        if not tok:
            return self._json(200, {"ok": False,
                "error": "No hay token de Linear ni en el proyecto ni global.",
                "source": ""})
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
            data = linear_query(query, token=tok)
        except LinearError as e:
            return self._json(200, {"ok": False, "error": str(e), "source": source})
        viewer = data.get("viewer") or {}
        nodes = ((viewer.get("assignedIssues") or {}).get("nodes")) or []
        issues = [self._li_map(n) for n in nodes]
        self._json(200, {"ok": True,
            "user": viewer.get("name") or viewer.get("email") or "",
            "issues": issues, "source": source})

    def _proj_linear_all(self, c: str, p: str):
        """Versión contextual de _linear_all (paginada). Mismo shape +
        `source` indicando si el token usado es del proyecto o global."""
        if not valid_name(c) or not valid_name(p):
            return self._json(400, {"error": "nombres no válidos"})
        if safe_join(c, p) is None:
            return self._json(404, {"error": "proyecto no existe"})
        tok, source = self._resolve_linear_token(c, p)
        if not tok:
            return self._json(200, {"ok": False,
                "error": "No hay token de Linear ni en el proyecto ni global.",
                "source": ""})
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
            for _ in range(12):
                data = linear_query(query, {"after": after}, timeout=30, token=tok)
                viewer = data.get("viewer") or viewer
                blk = data.get("issues") or {}
                vid = viewer.get("id", "")
                issues.extend(self._li_map(n, vid) for n in (blk.get("nodes") or []))
                pi = blk.get("pageInfo") or {}
                if not pi.get("hasNextPage"):
                    break
                after = pi.get("endCursor")
        except LinearError as e:
            return self._json(200, {"ok": False, "error": str(e), "source": source})
        self._json(200, {"ok": True,
            "user": viewer.get("name") or viewer.get("email") or "",
            "issues": issues, "source": source})
```

- [ ] **Step 3: Wirear `POST /api/projects/linear-token` en el dispatch POST**

Editar `backend/server.py` ~ línea 886. **Añadir** al dict `routes`:

```python
            "/api/projects/linear-token": self._proj_linear_token_save,
```

(Junto a `/api/projects/meta`.)

- [ ] **Step 4: Wirear `GET /api/projects/linear/{issues,all}` en `do_GET`**

Editar `backend/server.py` ~ línea 861. **Reemplazar** el bloque:

```python
        elif path in ("/api/linear/issues", "/api/linear/all"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            self._linear_issues() if path == "/api/linear/issues" else self._linear_all()
```

por:

```python
        elif path in ("/api/linear/issues", "/api/linear/all",
                      "/api/projects/linear/issues", "/api/projects/linear/all"):
            if not self._is_authed():
                return self._json(401, {"error": "no autorizado"})
            if path == "/api/linear/issues":
                self._linear_issues()
            elif path == "/api/linear/all":
                self._linear_all()
            else:
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                c = q.get("client", [""])[0]
                p = q.get("project", [""])[0]
                if path == "/api/projects/linear/issues":
                    self._proj_linear_issues(c, p)
                else:
                    self._proj_linear_all(c, p)
```

- [ ] **Step 5: Reiniciar y probar**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null; sleep 1
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/backend" && python3 server.py > /private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel.log 2>&1 &
sleep 2
curl -s -c /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/login \
  -H "Content-Type: application/json" -d '{"password":"uqTFZdDp5YOHPj8N"}'
echo
```

Token: set, verificar archivo, comprobar status. Sin token Linear válido aún:

```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/linear-token \
  -H "Content-Type: application/json" \
  -d '{"client":"test-client","project":"test-project","token":"lin_api_FAKE_TEST_TOKEN"}'
echo
ls -la "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project/.linear.token"
```
Expected: `{"ok": true, "set": true}`. Archivo con permisos `-rw-------`.

Verificar que el GET de meta refleja el status:

```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/meta?client=test-client&project=test-project" | python3 -m json.tool
```
Expected: `linear_status: {"has_project_token": true, "has_global_fallback": false}`.

Verificar que el endpoint de issues responde (con el token fake dará error de Linear, pero el path debe funcionar):

```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/linear/issues?client=test-client&project=test-project" | python3 -m json.tool
```
Expected: `{"ok": false, "error": "Token de Linear inválido o sin permisos.", "source": "project"}` (con el token fake; eso confirma que se está usando el token del proyecto).

Borrar token:
```bash
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/linear-token \
  -H "Content-Type: application/json" \
  -d '{"client":"test-client","project":"test-project","token":""}'
echo
ls "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project/" 2>&1 | grep -v linear.token && echo "linear.token borrado"
```
Expected: `{"ok": true, "set": false}`. El `.linear.token` desaparece.

Sin token de proyecto ni global, el endpoint debe responder con error legible:
```bash
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/linear/issues?client=test-client&project=test-project" | python3 -m json.tool
```
Expected: `{"ok": false, "error": "No hay token de Linear ni en el proyecto ni global.", "source": ""}`.

- [ ] **Step 6: Checkpoint** — Token endpoint OK, resolver con fallback OK, endpoints contextuales OK.

---

## Task 6: Frontend — Rename + barra `.proj-tabs`

**Files:**
- Modify: `frontend/index.html` (línea 25 + wrapping del `#main-row`)
- Modify: `frontend/styles.css` (comentario línea 113 + estilo `.proj-tabs`)

- [ ] **Step 1: Renombrar el botón "Desarrollo"**

Editar `frontend/index.html` línea 25. **Reemplazar:**

```html
    <button id="tabDev" class="tab active">Desarrollo</button>
```

por:

```html
    <button id="tabDev" class="tab active">Proyectos</button>
```

- [ ] **Step 2: Actualizar el comentario de CSS**

Editar `frontend/styles.css` línea 113. **Reemplazar:**

```css
/* pestañas de sección (Desarrollo / Monitorización) */
```

por:

```css
/* pestañas de sección (Proyectos / Monitorización) */
```

- [ ] **Step 3: Envolver el contenido del `#main-row` en `#repos-area` y añadir `.proj-tabs` + `#map-area`**

Editar `frontend/index.html`. Localizar el bloque `<div id="main-row" class="hidden">...</div>` (líneas ~53-90). **Sustituir** el tag de apertura por la nueva estructura **conservando el contenido interno literal**:

Antes:
```html
  <div id="main-row" class="hidden">
    ... (contenido actual: sidebar repos + conversaciones + chat) ...
  </div>
```

Después:
```html
  <div id="main-row" class="hidden">
    <div class="proj-tabs">
      <button class="proj-tab active" data-view="repos">Repos</button>
      <button class="proj-tab" data-view="map">Mapa</button>
    </div>
    <div id="repos-area">
      ... (contenido actual: sidebar repos + conversaciones + chat) ...
    </div>
    <div id="map-area" class="hidden">
      <!-- placeholder; el formulario se inyecta en Task 7 -->
    </div>
  </div>
```

(Importante: NO tocar el contenido interno —repos sidebar, conversaciones, chat—. Solo envolverlo en `#repos-area` y añadir los hermanos `.proj-tabs` y `#map-area`.)

- [ ] **Step 4: Añadir CSS para `.proj-tabs`**

Editar `frontend/styles.css`. **Al final del archivo** añadir:

```css
/* sub-pestañas dentro de un Proyecto (Fase 1: Repos vs Mapa) */
.proj-tabs { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg); }
.proj-tab { background: transparent; border: 1px solid transparent; color: var(--muted);
            border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 13px; }
.proj-tab:hover { color: var(--text); }
.proj-tab.active { color: var(--text); background: var(--tool); border-color: var(--border); }
```

- [ ] **Step 5: Verificación visual en navegador**

Reiniciar server (ya está corriendo en background del Task 5; el CSS/HTML se recarga al refrescar). Abrir o recargar `http://127.0.0.1:8788` y verificar:

- [ ] La pestaña del header dice **"Proyectos"** (no "Desarrollo").
- [ ] Al entrar a un Proyecto y luego a su pantalla de repos, en la parte superior del workspace aparecen dos botones: **[Repos]** (activo) y **[Mapa]** (inactivo).
- [ ] Click en "Mapa" todavía NO hace nada (el handler llega en Task 9). Es esperado.

- [ ] **Step 6: Checkpoint** — Rename ✓, estructura HTML ✓, estilos visibles ✓.

---

## Task 7: Frontend — Editor "Mapa" HTML (sección Linear + servicios + conexiones + modales)

**Files:**
- Modify: `frontend/index.html` (rellena `#map-area`; añade 3 modales nuevos al final del `<body>`)

- [ ] **Step 1: Rellenar el `#map-area` con la estructura del editor**

Editar `frontend/index.html`. Localizar el `<div id="map-area" class="hidden"></div>` creado en Task 6 y **sustituir su contenido placeholder por:**

```html
    <div id="map-area" class="hidden">
      <div class="map-editor">

        <section class="map-block">
          <h3>Linear del proyecto</h3>
          <div class="map-linear-status">
            <span id="mapLinearBadge" class="badge muted">no configurado</span>
            <span id="mapLinearFallback" class="meta hidden">usando token global (fallback)</span>
          </div>
          <div class="map-actions">
            <button id="mapLinearSet" class="btn">Configurar token</button>
            <button id="mapLinearDel" class="btn danger hidden">Borrar token</button>
          </div>
        </section>

        <section class="map-block">
          <h3>Servicios (zonas)</h3>
          <div class="map-actions"><button id="mapSvcAdd" class="btn">+ Añadir servicio</button></div>
          <ul id="mapSvcList" class="map-list"></ul>
          <div id="mapSvcEmpty" class="map-empty">Sin servicios todavía.</div>
        </section>

        <section class="map-block">
          <h3>Conexiones (cables)</h3>
          <div class="map-actions"><button id="mapConnAdd" class="btn">+ Añadir conexión</button></div>
          <ul id="mapConnList" class="map-list"></ul>
          <div id="mapConnEmpty" class="map-empty">Sin conexiones todavía.</div>
        </section>

        <div class="map-savebar">
          <span id="mapDirtyHint" class="meta hidden">Cambios sin guardar</span>
          <button id="mapSave" class="btn primary" disabled>Guardar cambios</button>
        </div>

      </div>
    </div>
```

- [ ] **Step 2: Añadir los 3 modales al final del `<body>` (antes del `<script>`)**

Editar `frontend/index.html`. Localizar el `<script src="/static/app.js"></script>` cerca del final. **Justo antes** de ese tag, añadir:

```html
  <!-- Modales del editor Mapa (Fase 1) -->
  <div id="svcModal" class="modal hidden">
    <div class="modal-card">
      <h3 id="svcModalTitle">Añadir servicio</h3>
      <label>Tipo
        <select id="svcModalKind">
          <option value="vps">vps</option>
          <option value="n8n">n8n</option>
          <option value="docker">docker</option>
          <option value="chatwoot">chatwoot</option>
          <option value="postgres">postgres</option>
          <option value="github">github</option>
          <option value="linear">linear</option>
          <option value="custom">custom</option>
        </select>
      </label>
      <label>Nombre
        <input id="svcModalName" type="text" maxlength="100" placeholder="P. ej. VPS principal">
      </label>
      <label>Config (JSON)
        <textarea id="svcModalConfig" rows="6" placeholder='{"host":"1.2.3.4","user":"ubuntu"}'></textarea>
      </label>
      <div class="modal-err" id="svcModalErr"></div>
      <div class="modal-actions">
        <button id="svcModalCancel" class="btn">Cancelar</button>
        <button id="svcModalSave" class="btn primary">Guardar</button>
      </div>
    </div>
  </div>

  <div id="connModal" class="modal hidden">
    <div class="modal-card">
      <h3 id="connModalTitle">Añadir conexión</h3>
      <label>Desde <select id="connModalFrom"></select></label>
      <label>Hasta <select id="connModalTo"></select></label>
      <label>Etiqueta (opcional)
        <input id="connModalLabel" type="text" maxlength="80" placeholder="host, webhooks, queries...">
      </label>
      <div class="modal-err" id="connModalErr"></div>
      <div class="modal-actions">
        <button id="connModalCancel" class="btn">Cancelar</button>
        <button id="connModalSave" class="btn primary">Guardar</button>
      </div>
    </div>
  </div>

  <div id="linTokenModal" class="modal hidden">
    <div class="modal-card">
      <h3>Token de Linear del proyecto</h3>
      <p class="modal-help">Pega un API key personal de Linear (empieza por <code>lin_api_</code>).
        Nunca se devuelve al navegador.</p>
      <label>Token
        <input id="linTokenInput" type="password" placeholder="lin_api_..." autocomplete="off">
      </label>
      <div class="modal-err" id="linTokenErr"></div>
      <div class="modal-actions">
        <button id="linTokenCancel" class="btn">Cancelar</button>
        <button id="linTokenSave" class="btn primary">Guardar</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Verificación visual rápida**

Recargar `http://127.0.0.1:8788` en el navegador. La pestaña "Mapa" todavía no se activa (handler en Task 9), pero abre el HTML con DevTools y comprueba:

- [ ] El `<div id="map-area">` ya tiene las 3 secciones (Linear, Servicios, Conexiones) y la barra de guardar.
- [ ] Los 3 modales (`#svcModal`, `#connModal`, `#linTokenModal`) están en el DOM con clase `hidden`.

- [ ] **Step 4: Checkpoint** — Estructura HTML del editor y modales en sitio.

---

## Task 8: Frontend — CSS del editor "Mapa" y modales

**Files:**
- Modify: `frontend/styles.css` (al final del archivo)

- [ ] **Step 1: Añadir estilos del editor y modales**

Editar `frontend/styles.css`. **Al final del archivo** añadir:

```css
/* Editor "Mapa" (Fase 1) */
.map-editor { padding: 16px; max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
.map-block { background: var(--tool); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.map-block h3 { margin: 0 0 10px 0; font-size: 14px; color: var(--text); }
.map-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.map-list { list-style: none; padding: 0; margin: 6px 0 0 0; display: flex; flex-direction: column; gap: 4px; }
.map-empty { color: var(--muted); font-size: 12px; padding: 4px 0; }
.map-linear-status { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.map-savebar { display: flex; gap: 12px; align-items: center; justify-content: flex-end; padding: 8px 0; border-top: 1px solid var(--border); }
.map-savebar .meta { color: var(--muted); font-size: 12px; }

/* Filas de servicio y conexión */
.svc-row, .conn-row { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border-radius: 6px; }
.svc-row:hover, .conn-row:hover { background: var(--bg); }
.svc-kind-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--bg);
                  color: var(--muted); font-size: 11px; font-family: monospace; min-width: 64px; text-align: center; }
.svc-name, .conn-text { flex: 1; color: var(--text); font-size: 13px; }
.svc-cfg, .conn-label { color: var(--muted); font-size: 12px; font-family: monospace; }
.row-actions { display: flex; gap: 4px; }
.btn-mini { background: transparent; border: 1px solid var(--border); color: var(--muted);
            border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
.btn-mini:hover { color: var(--text); }
.btn-mini.danger:hover { color: #ef4444; border-color: #ef4444; }

/* Badges genéricos reutilizables */
.badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px;
         border: 1px solid var(--border); }
.badge.muted { color: var(--muted); }
.badge.ok { color: #22c55e; border-color: #22c55e; }

/* Modales (Fase 1: comparten estilo, sencillos) */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex;
         align-items: center; justify-content: center; z-index: 1000; }
.modal.hidden { display: none; }
.modal-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
              padding: 20px; min-width: 360px; max-width: 520px; width: 90%;
              display: flex; flex-direction: column; gap: 10px; }
.modal-card h3 { margin: 0 0 6px 0; font-size: 15px; }
.modal-card label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
.modal-card input[type="text"], .modal-card input[type="password"],
.modal-card select, .modal-card textarea {
  background: var(--tool); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 8px; font-size: 13px; font-family: inherit;
}
.modal-card textarea { font-family: monospace; resize: vertical; }
.modal-help { color: var(--muted); font-size: 12px; margin: 0; }
.modal-err { color: #ef4444; font-size: 12px; min-height: 16px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }
```

- [ ] **Step 2: Verificación visual**

Recargar el navegador. Abre DevTools → fuerza `display: flex` sobre `#svcModal` para visualizarlo brevemente y comprobar que tiene estilo (centrado, tarjeta con padding, inputs visibles). Después devuélvele `display: none` para no dejarlo abierto.

```js
// en la consola del navegador
document.querySelector('#svcModal').classList.remove('hidden');
// → debe verse el modal centrado, con estilos. Tras inspeccionar:
document.querySelector('#svcModal').classList.add('hidden');
```

- [ ] **Step 3: Checkpoint** — Estilos del editor y modales aplicados correctamente.

---

## Task 9: Frontend — JS: estado del editor + tab switching + load/render

**Files:**
- Modify: `frontend/app.js` (añadir bloque nuevo tras el código de proyectos, antes de la sección de Linear)

- [ ] **Step 1: Localizar punto de inserción**

Buscar en `frontend/app.js` la línea `// ---- repos (workspace de desarrollo) ----` (alrededor de la línea 217) y la función `enterReposView()` que la sigue. **Inmediatamente antes** de ese comentario añadiremos un bloque nuevo. Localiza también, al final del archivo, dónde se registran los handlers de Linear (`$("#linProject").onchange = ...`, línea ~856) — nuestro bloque irá antes.

- [ ] **Step 2: Añadir estado y funciones del editor Mapa**

Editar `frontend/app.js`. **Justo antes** de la línea `// ---- repos (workspace de desarrollo) ----`, añadir:

```javascript
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
  if (view === "map") enterMapTab();
}

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

// Placeholders: implementados en Tasks 10 y 11. Necesarios aquí solo para que
// los onclick de renderMap() y los handlers no rompan si se ejecutan antes.
function openSvcModal(id) { /* Task 10 */ }
function deleteSvc(id) { /* Task 10 */ }
function deleteConn(id) { /* Task 11 */ }
```

- [ ] **Step 3: Verificación funcional**

Recargar el navegador. Entrar a un Proyecto y hacer click en la pestaña **"Mapa"**. Esperado:

- [ ] La pestaña "Mapa" se activa visualmente (clase `.active`).
- [ ] `#repos-area` se oculta, `#map-area` se muestra.
- [ ] Se cargan datos del backend: badge "configurado ✓" o "no configurado" según el estado del proyecto de pruebas.
- [ ] Si el proyecto del sandbox tiene los servicios que guardaste en Task 4, aparecen listados.
- [ ] Las conexiones aparecen como "Nombre → Nombre".
- [ ] Click en "Repos" vuelve al workspace de repos sin perder estado.

Si vienes de borrar/recrear el sandbox y está vacío, prueba a guardar 3 servicios + 1 conexión vía curl (Task 4 y 5) y refresca el editor — deben aparecer.

- [ ] **Step 4: Checkpoint** — Editor carga y pinta correctamente. Acciones aún no funcionales.

---

## Task 10: Frontend — JS: modal de servicio (añadir / editar / borrar con limpieza de conexiones huérfanas)

**Files:**
- Modify: `frontend/app.js` (sustituir los placeholders `openSvcModal` y `deleteSvc` añadidos en Task 9)

- [ ] **Step 1: Sustituir los placeholders por la implementación real**

En `frontend/app.js`, **localizar el bloque** añadido en Task 9 con los comentarios `// Task 10` y **reemplazar las funciones** `openSvcModal` y `deleteSvc` (y añadir helpers asociados):

```javascript
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
```

(Eliminar los stubs `function openSvcModal(id) { /* Task 10 */ }` y `function deleteSvc(id) { /* Task 10 */ }` del bloque añadido en Task 9; sustituirlos por este código completo.)

- [ ] **Step 2: Verificación funcional**

Recargar navegador. En la pestaña Mapa de un proyecto:

- [ ] Click en "+ Añadir servicio" → modal aparece, `kind` editable.
- [ ] Tipo: `vps`, Nombre: `Test VPS`, Config: `{"host":"5.5.5.5"}` → "Guardar" → modal se cierra, servicio aparece en la lista, hint "Cambios sin guardar" visible, botón "Guardar cambios" habilitado.
- [ ] Click en "Editar" del servicio → modal con datos cargados, `kind` deshabilitado. Cambia el nombre → guardar → cambio visible.
- [ ] Click en "Borrar" del servicio → confirmación → desaparece de la lista.
- [ ] Si tenías una conexión que lo referenciaba, también desaparece.
- [ ] Validaciones: nombre vacío → error en modal. Config no-JSON (`{abc}`) → error en modal. Config array (`[1,2]`) → error en modal.

(El botón "Guardar cambios" no persiste todavía hasta Task 12; los cambios viven solo en memoria.)

- [ ] **Step 3: Checkpoint** — Modal de servicio funcional, limpieza de huérfanas operativa.

---

## Task 11: Frontend — JS: modal de conexión + modal de token Linear

**Files:**
- Modify: `frontend/app.js` (sustituir placeholder `deleteConn`; añadir openConnModal, saveConnFromModal, openLinTokenModal, saveLinTokenFromModal, deleteLinToken)

- [ ] **Step 1: Sustituir placeholder `deleteConn` y añadir resto de funciones**

En `frontend/app.js`, **localizar** el placeholder `function deleteConn(id) { /* Task 11 */ }` del Task 9 y **reemplazarlo + añadir lo siguiente** justo después:

```javascript
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
```

- [ ] **Step 2: Verificación funcional**

Recargar navegador. En la pestaña Mapa:

- [ ] Click "+ Añadir conexión" con < 2 servicios → alert "Necesitas al menos 2 servicios". Si tienes ≥ 2 → modal con selects pre-poblados.
- [ ] Selecciona From/To distintos, label "test" → guardar → conexión aparece en la lista. Hint "Cambios sin guardar" visible.
- [ ] Mismo From y To → error "no pueden ser el mismo".
- [ ] Click "Borrar" en una conexión → confirmación → desaparece.
- [ ] Click "Configurar token" → modal aparece. Pega `lin_api_FAKE_TEST_TOKEN` → "Guardar" → modal se cierra, badge pasa a "configurado ✓", botón "Borrar token" visible.
- [ ] Click "Borrar token" → confirmación → badge vuelve a "no configurado", botón "Borrar token" se oculta.

(El token sí persiste inmediatamente porque tiene su propio endpoint — no necesita "Guardar cambios".)

- [ ] **Step 3: Checkpoint** — Modal de conexión y de token Linear funcionales.

---

## Task 12: Frontend — JS: botón "Guardar cambios" (persiste meta completa)

**Files:**
- Modify: `frontend/app.js` (añadir handler del botón `#mapSave`)

- [ ] **Step 1: Añadir handler de guardado**

En `frontend/app.js`, **al final del bloque del editor Mapa** añadido en Tasks 9-11 (justo antes de la línea `// ---- repos (workspace de desarrollo) ----`), añadir:

```javascript
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
```

- [ ] **Step 2: Verificación end-to-end**

Recargar navegador. En la pestaña Mapa:

- [ ] Añade 2 servicios y 1 conexión → "Guardar cambios" se habilita.
- [ ] Click "Guardar cambios" → spinner breve → vuelve a estar deshabilitado, hint desaparece.
- [ ] Recarga la página (F5), entra de nuevo a Mapa → todo persistió y los ids ahora están asignados.
- [ ] Edita un servicio existente → guardar funciona, mantiene el mismo id.
- [ ] Borra un servicio que tiene conexiones → la conexión también desaparece (limpieza huérfana del Task 10) → guardar funciona sin 400.
- [ ] Comprueba en disco:
  ```bash
  cat "/private/tmp/claude-501/-Users-albertodelpozo-Documents-BO-Adelpozor/243325e8-b759-4a64-ba54-f6e65c5d143b/scratchpad/panel-projects/test-client/test-project/.panel.json"
  ```
  Debe coincidir con lo que ves en el editor.

- [ ] **Step 3: Checkpoint** — Persistencia end-to-end funcional.

---

## Task 13: Frontend — Linear contextualizada al proyecto activo

**Files:**
- Modify: `frontend/app.js` (refactor pequeño en `linearEnter` y/o `loadLinear` para usar endpoints contextuales cuando hay proyecto activo)

- [ ] **Step 1: Identificar funciones a tocar**

Run:
```bash
grep -n "linearEnter\|loadLinear\|linEnter\|linLoad\|linearLoaded\|/api/linear/" "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO/frontend/app.js"
```

Localizar la(s) función(es) que actualmente hacen `fetch("/api/linear/issues")` y `fetch("/api/linear/all")`. Lo más probable: están dentro de una función `linearEnter()` o similar que se llama desde `setSection("linear")` (línea 104 según exploración previa).

- [ ] **Step 2: Refactor para usar endpoints contextuales**

En `frontend/app.js`, dentro de la función que actualmente hace `fetch("/api/linear/all")` (y/o `/api/linear/issues`):

- Detectar si hay proyecto activo: `selClient` y `selProject` no-vacíos **y** estamos en pantalla de repos (`devScreen === "repos"`).
- Si lo hay → usar endpoints contextuales con query params.
- Si no → seguir usando los globales como hoy.
- Pintar un encabezado contextual en la vista Linear.

**Ejemplo concreto** (el agente debe adaptarlo al nombre real de la función — el patrón es siempre el mismo). Sustituir:

```javascript
// Original (aprox):
const r = await fetch("/api/linear/all");
```

por:

```javascript
const inProject = !!(selClient && selProject && devScreen === "repos");
const url = inProject
  ? `/api/projects/linear/all?client=${encodeURIComponent(selClient)}&project=${encodeURIComponent(selProject)}`
  : "/api/linear/all";
const r = await fetch(url);
```

Lo mismo para `/api/linear/issues` → `/api/projects/linear/issues?...`.

**Cabecera contextual:** localizar el `<h2>` o título de la vista Linear en `index.html` (sección `#linear-view`). En la función `linearEnter` (o equivalente), **antes** de pintar las issues, actualizar ese título:

```javascript
const titleEl = $("#linearTitle");  // ajusta el selector al elemento real del título
if (titleEl) {
  if (inProject) {
    titleEl.textContent = `Linear de ${selClient} / ${selProject}`;
  } else {
    titleEl.textContent = "Linear (global)";
  }
}
```

Y, tras obtener la respuesta JSON, si `data.source === "global"` y `inProject`, añadir un aviso visual:

```javascript
if (inProject && data.source === "global") {
  // Mostrar un pequeño aviso "Usando token global (fallback)" cerca del título.
  // Reutilizar un elemento existente o añadir uno con clase `.meta`.
}
```

**Nota para el implementador:** si `#linearTitle` no existe en el HTML actual, **añadirlo** en `frontend/index.html` dentro de `#linear-view` como primer hijo (`<h2 id="linearTitle">Linear</h2>`), con CSS mínimo (`#linearTitle { margin: 0 0 10px 0; font-size: 14px; }` al final de `styles.css`).

- [ ] **Step 3: Verificación con curl + navegador**

Verificación con curl primero (asumiendo token fake activo en el sandbox):

```bash
# Set fake token al proyecto
curl -s -b /tmp/panel-cookie -X POST http://127.0.0.1:8788/api/projects/linear-token \
  -H "Content-Type: application/json" \
  -d '{"client":"test-client","project":"test-project","token":"lin_api_FAKE"}'
echo
# Issues contextual: debe responder con source=project (aunque error de token)
curl -s -b /tmp/panel-cookie "http://127.0.0.1:8788/api/projects/linear/issues?client=test-client&project=test-project" | python3 -m json.tool
```
Expected: `source: "project"` en la respuesta.

Verificación en navegador (necesitas un token Linear REAL para ver issues; con uno fake solo verás el error):

- [ ] Sin entrar a un proyecto, click pestaña Linear del header → cabecera "Linear (global)", consume `/api/linear/issues|all` (DevTools → Network).
- [ ] Entra a un proyecto, click pestaña Linear → cabecera "Linear de Cliente / Proyecto", consume `/api/projects/linear/issues|all` (DevTools → Network).
- [ ] Si el proyecto tiene token configurado, las issues son del workspace del proyecto. Si no, el aviso de fallback aparece.

- [ ] **Step 4: Checkpoint** — Linear contextual funciona end-to-end.

---

## Task 14: Verificación manual con checklist completa + commit único

**Files:** ninguno (verificación) + commit final.

- [ ] **Step 1: Ejecutar la checklist del spec (sección 6)**

Recorrer la checklist completa de `docs/superpowers/specs/2026-06-30-proyectos-mapa-fase1-design.md` sección 6:

**Rename y flujo básico**
- [ ] Botón header dice "Proyectos".
- [ ] Crear Cliente → Proyecto → entrar al Proyecto funciona igual que antes.
- [ ] Pestaña "Repos" del proyecto sigue mostrando repos como hoy.

**Editor Mapa happy path**
- [ ] Editor vacío en proyecto recién creado.
- [ ] Token Linear: configurar / status / persistencia.
- [ ] Añadir 3 servicios + 2 conexiones, guardar, recargar → persisten con ids.
- [ ] `.panel.json` y `.linear.token` en disco con permisos 600.

**Linear contextual**
- [ ] Con proyecto activo + token: cabecera "Linear de C/P", issues del proyecto.
- [ ] Con proyecto activo sin token: aviso fallback global.
- [ ] Sin proyecto activo: funciona como hoy (global).

**Validaciones** (curl manual)
- [ ] kind fuera del enum → 400.
- [ ] Conexión a id inexistente → 400.
- [ ] `client=../foo` → 400.
- [ ] name vacío o > 100 → 400.
- [ ] > 100 servicios / > 500 conexiones → 400.
- [ ] Borrar token → status "no configurado", `.linear.token` desaparece.

**Seguridad**
- [ ] Token Linear NO aparece en respuestas API (DevTools → Network).
- [ ] `ls -la` → permisos 600.
- [ ] `.panel.json` con JSON inválido → 500 legible, archivo no se sobreescribe.
- [ ] `.panel.json` borrado a mano → siguiente GET devuelve estado vacío sin error.

**Compatibilidad**
- [ ] Proyectos sin `.panel.json` siguen funcionando en pestaña Repos.
- [ ] Linear header sin proyecto activo: funciona con token global como hoy.
- [ ] Pestaña Monitorización: sin cambios.

Si algo falla → volver a la tarea correspondiente, arreglar, repetir verificación.

- [ ] **Step 2: Apagar server local**

Run:
```bash
pkill -f "python3 server.py" 2>/dev/null
sleep 1
lsof -nP -iTCP:8788 -sTCP:LISTEN 2>&1 || echo "puerto libre"
```

- [ ] **Step 3: Estado de git previo al commit**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git status
```

Expected: deben aparecer modificados `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`, `backend/server.py`, `.gitignore`; y como nuevos `docs/superpowers/specs/2026-06-30-proyectos-mapa-fase1-design.md` y `docs/superpowers/plans/2026-06-30-proyectos-mapa-fase1-plan.md`.

**Importante:** NO debe aparecer `backend/panel.conf` (es config local para preview, ya está gitignored). Si aparece, revisar `.gitignore`.

- [ ] **Step 4: Stage selectivo (no incluir `panel.conf` ni nada raro)**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && \
git add .gitignore \
        frontend/index.html frontend/app.js frontend/styles.css \
        backend/server.py \
        docs/superpowers/specs/2026-06-30-proyectos-mapa-fase1-design.md \
        docs/superpowers/plans/2026-06-30-proyectos-mapa-fase1-plan.md
git status
```

Expected: el `git status` muestra esos 6 archivos como staged y nada extra.

- [ ] **Step 5: Crear commit con HEREDOC**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git commit -m "$(cat <<'EOF'
feat(proyectos+mapa fase1): rename Desarrollo→Proyectos, metadata por proyecto y token Linear contextual

- frontend: pestaña header "Proyectos"; sub-pestaña "Mapa" en cada proyecto
  con editor formulario para servicios (zonas), conexiones (cables) y token
  Linear; pestaña Linear del header pasa a ser contextual al proyecto activo
  con fallback al token global.
- backend: nuevos helpers para .panel.json y .linear.token por proyecto
  (permisos 600); cinco endpoints nuevos (GET/POST /api/projects/meta,
  POST /api/projects/linear-token, GET /api/projects/linear/{issues,all});
  refactor mínimo de linear_query para aceptar token opcional sin breaking
  changes para los endpoints globales existentes.
- docs: spec y plan en docs/superpowers/{specs,plans}/.
- gitignore: .panel.json y .linear.token.

Sin tests automatizados (el proyecto no tiene framework; se difiere a Fase 2).
Verificación manual con checklist del spec.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0161kKVTR9U7cMCCVkEvFaDZ
EOF
)"
```

- [ ] **Step 6: Verificar commit**

Run:
```bash
cd "/Users/albertodelpozo/Documents/BO Adelpozor/AdelpozoBO" && git log -1 --stat
```

Expected: 1 commit con los 6 archivos listados arriba, autor `adelpozor1`, co-author Claude.

- [ ] **Step 7: Checkpoint** — Fase 1 completada y commiteada en un único commit limpio.

---

## Self-review (post-write)

**Spec coverage:** Cada sección del spec tiene tarea:

- Rename Desarrollo→Proyectos → Task 6.
- Sub-pestaña Mapa con tabs → Tasks 6 (estructura) + 9 (handler).
- Editor formulario (Linear + servicios + conexiones) → Tasks 7 (HTML), 8 (CSS), 9-12 (JS).
- Modelo `.panel.json` y `.linear.token` con permisos 600 → Task 2.
- 5 endpoints backend → Tasks 3-5.
- Validación de input → Task 2 (`validate_meta_payload`) + uso en Tasks 3-5.
- Linear pestaña header contextual → Task 13.
- Fallback project > global → Task 5 (`_resolve_linear_token`).
- `.gitignore` → Task 1.
- Verificación manual con checklist → Task 14.
- Sin tests automatizados → política respetada (verificación con curl + browser por cada task).

**Placeholders:** Las únicas referencias a "Task N" / "implementado en Task X" están en stubs explícitos del Task 9 que se sustituyen en Tasks 10/11; no son placeholders sino contratos cruzados. El "ejemplo concreto" del Task 13 sí pide al implementador adaptar nombres reales — está marcado con "Nota para el implementador" y describe exactamente el patrón. Aceptable porque el nombre exacto de la función depende del estado actual de `app.js` y mi exploración no me dio la línea precisa (es seguro que existe; la primera vez que veas `fetch("/api/linear/all"` ahí está).

**Type consistency:**

- `SVC_KINDS` en backend (`server.py`) coincide con el `SVC_KINDS` en frontend (`app.js`) y con los `<option>` del select del modal (`index.html`). 8 valores: vps, n8n, docker, chatwoot, postgres, github, linear, custom.
- `meta_path` / `linear_token_path` usados sólo desde `load_/save_project_meta` y `read_/save_project_linear_token`.
- `_resolve_linear_token` devuelve `(token, source)` con source ∈ {"project", "global", ""}; consumido en `_proj_linear_issues` y `_proj_linear_all`.
- `mapState = { services, connections, linear_status }` consistente entre `loadMeta`, `renderMap`, `saveMap`, y los modales.
- `selClient` / `selProject` ya existen en `app.js` (verificado en exploración: líneas 147, 151, 195, 199). No introduzco una variable nueva `currentProject` — uso lo que ya hay.

**Caveat de implementación:** Task 13 depende de conocer el nombre exacto de la función que hace `fetch("/api/linear/*")` en `app.js`. El grep del Step 1 del Task 13 sirve para localizarla. Si la búsqueda devuelve más de un sitio, aplicar el mismo patrón en todos.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-30-proyectos-mapa-fase1-plan.md`. Dos opciones de ejecución:**

**1. Subagent-Driven (recomendado para este plan)** — Despacho un subagente fresco por tarea con review entre tareas. Pro: contexto limpio por tarea, menor riesgo de arrastrar errores. Contra: cada subagente tiene que re-leer ficheros (más tokens).

**2. Inline Execution** — Ejecuto las tareas en esta sesión con checkpoints para que me digas si pausar/cambiar. Pro: menos overhead, contexto ya cargado. Contra: si algo va mal a mitad, el debug se hace en este mismo contexto.

¿Cuál prefieres?
