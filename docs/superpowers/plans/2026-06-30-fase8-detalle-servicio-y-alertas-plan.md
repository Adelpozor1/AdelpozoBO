# Fase 8 — Detalle por servicio + alertas (plan ejecutable)

> **Política del plan (recurrente del usuario):** UN ÚNICO COMMIT AL FINAL. Cada task verifica (curl/browser/checklist) pero NO commitea. Sin tests automatizados.

**Goal:** Drill-in por VPS con detalle real por servicio (n8n / postgres / chatwoot / backoffice) + alertas configurables por proyecto evaluadas en el health_poll_loop existente.

**Architecture:** Reutiliza `ssh_run` + `HEALTH_CACHE` de F6. Añade endpoint `/api/services/detail` con probes por kind y cache TTL 15s. Añade `.alerts.json` por proyecto + evaluador en el daemon de poll + endpoints CRUD. Frontend: nueva vista detalle full-page + drawer por servicio + banner global.

**Tech Stack:** Python stdlib only (backend), vanilla HTML/CSS/JS (frontend), SVG inline (mini-grafo FKs).

---

## Task 1 — Backend: schema v4→v5 + storage de alertas

**Files:**
- Modify: `backend/server.py` (validate_meta_payload, añadir SCHEMA_VERSION bump, alerts_path/load_alerts/save_alerts)

### Step 1.1 — Bump SCHEMA_VERSION

Buscar `SCHEMA_VERSION` actual y subir a 5. Documentar en docstring qué cambia.

```python
# Localizar la constante y cambiar el valor:
SCHEMA_VERSION = 5  # antes 4
# F5: kind, on_host, satellites_of, position, interior_position, world_position
# F8: + config.role, config.container, config.health_url
```

### Step 1.2 — Aceptar campos nuevos en `validate_meta_payload`

Buscar la función `validate_meta_payload` (≈ línea 429) y, en el bloque donde se valida `config` por service, añadir los tres campos opcionales:

```python
ROLES_OK = {"db", "backoffice", "n8n", "chatwoot", "app", "other"}

# dentro del loop por service, después de validar on_host/satellites_of:
role = cfg_in.get("role")
if role is not None:
    if not isinstance(role, str) or role not in ROLES_OK:
        return None, f"service[{i}].config.role inválido"
    cfg_out["role"] = role

container = cfg_in.get("container")
if container is not None:
    if not isinstance(container, str) or len(container) > 200:
        return None, f"service[{i}].config.container inválido"
    cfg_out["container"] = container.strip()

health_url = cfg_in.get("health_url")
if health_url is not None:
    if not isinstance(health_url, str) or len(health_url) > 200:
        return None, f"service[{i}].config.health_url inválido"
    if not (health_url.startswith("http://") or health_url.startswith("https://")):
        return None, f"service[{i}].config.health_url debe empezar por http(s)://"
    cfg_out["health_url"] = health_url.strip()
```

### Step 1.3 — Helpers de alertas

Añadir bloque cerca de los helpers `meta_path` / `linear_token_path`:

```python
def alerts_path(c: str, p: str) -> Path | None:
    """Ruta al .alerts.json del proyecto, o None si no resuelve."""
    pp = project_path(c, p, must_exist=False)
    if pp is None:
        return None
    return pp / ".alerts.json"


def load_alerts(c: str, p: str) -> dict:
    """Carga .alerts.json del proyecto. Estructura por defecto si no existe."""
    ap = alerts_path(c, p)
    default = {"version": 1, "rules": []}
    if ap is None or not ap.exists():
        return default
    try:
        data = json.loads(ap.read_text())
        if not isinstance(data, dict) or "rules" not in data:
            return default
        if not isinstance(data["rules"], list):
            data["rules"] = []
        return data
    except (json.JSONDecodeError, OSError):
        return default


def save_alerts(c: str, p: str, data: dict) -> None:
    """Persiste .alerts.json con permisos 600."""
    ap = alerts_path(c, p)
    if ap is None:
        raise ValueError("ruta de proyecto no válida")
    ap.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    try:
        os.chmod(ap, 0o600)
    except OSError:
        pass


ALERT_KINDS = {"cpu_above", "ram_above", "disk_above",
               "container_down", "n8n_workflow_failed", "health_url_not_2xx"}


def validate_alerts_payload(payload: dict) -> tuple[dict | None, str]:
    """Valida la estructura de un .alerts.json entrante. Retorna (normalizado, error)."""
    if not isinstance(payload, dict):
        return None, "payload no es objeto"
    rules_in = payload.get("rules", [])
    if not isinstance(rules_in, list):
        return None, "rules debe ser lista"
    out_rules = []
    for i, r in enumerate(rules_in):
        if not isinstance(r, dict):
            return None, f"rule[{i}] no es objeto"
        rid = (r.get("id") or "").strip() or _new_id("alr")
        svc = (r.get("service_id") or "").strip()
        kind = (r.get("kind") or "").strip()
        if not svc:
            return None, f"rule[{i}].service_id requerido"
        if kind not in ALERT_KINDS:
            return None, f"rule[{i}].kind inválido"
        threshold = r.get("threshold")
        if kind in ("cpu_above", "ram_above", "disk_above"):
            try:
                threshold = float(threshold)
            except (TypeError, ValueError):
                return None, f"rule[{i}].threshold numérico requerido para {kind}"
            if not (0 <= threshold <= 100):
                return None, f"rule[{i}].threshold debe estar entre 0 y 100"
        else:
            threshold = None
        out_rules.append({
            "id": rid,
            "service_id": svc,
            "kind": kind,
            "threshold": threshold,
            "enabled": bool(r.get("enabled", True)),
            "label": (r.get("label") or "").strip()[:120] or None,
        })
    return {"version": 1, "rules": out_rules}, ""
```

### Step 1.4 — Añadir `.alerts.json` al .gitignore

Buscar el `.gitignore` raíz y añadir línea (si no existe ya `.alerts.json`):

```
# Reglas de alertas por proyecto (Fase 8)
projects/*/*/.alerts.json
```

### Checkpoint Task 1

- Arrancar backend (`python3 backend/server.py &` desde el repo).
- `curl -s -b "auth=$TOK" 'http://127.0.0.1:8788/api/projects/meta?client=test-client&project=test-project' | python3 -c 'import sys,json; d=json.load(sys.stdin); print("v=", d.get("version"))'` → debería responder `v= 5` si los meta nuevos se serializan con la versión bumpeada (si load_project_meta no inyecta version, ignorar; sólo verificamos que no haya 500).
- NO commit aún.

---

## Task 2 — Backend: probes por kind + DETAIL_CACHE

**Files:**
- Modify: `backend/server.py` (nuevo bloque "Fase 8 — probes por servicio" después del bloque F6 health polling).

### Step 2.1 — Constantes y cache

Añadir justo después del bloque F6 (después de `health_poll_loop`):

```python
# ============================================================ #
# Fase 8 — Detalle por servicio (probes específicos por kind)   #
# ============================================================ #
DETAIL_CACHE = {}              # service_id → {"ts", "data", "error"}
DETAIL_LOCK = threading.Lock()
DETAIL_TTL = 15                # segundos
DETAIL_TIMEOUT = 20            # SSH timeout por probe
LOGS_TAIL = 200                # líneas de docker logs
SCHEMA_TABLE_CAP = 200
SCHEMA_COLUMN_CAP = 2000
```

### Step 2.2 — Helpers de resolución

```python
def _build_host_from_vps(vps_service: dict) -> dict:
    """Construye dict host para ssh_run a partir de un service kind=vps."""
    cfg = vps_service.get("config") or {}
    return {
        "id": vps_service["id"],
        "name": vps_service["name"],
        "ssh_host": cfg.get("host", ""),
        "ssh_user": cfg.get("user", ""),
        "ssh_port": cfg.get("port", 22),
        "identity_file": cfg.get("ssh_key", ""),
        # Para reusar build_collector si hace falta:
        "db_container": "",
        "n8n_container": "",
        "db_user": "postgres", "db_name": "", "db_password": "",
        "n8n_url": "",
    }


def _find_service(meta: dict, service_id: str) -> dict | None:
    for s in meta.get("services", []) or []:
        if s.get("id") == service_id:
            return s
    return None


def _find_host_vps(meta: dict, service: dict) -> dict | None:
    """Devuelve el service kind=vps que aloja a `service` (o el propio si es vps)."""
    if service.get("kind") == "vps":
        return service
    on_host = (service.get("config") or {}).get("on_host")
    if not on_host:
        return None
    for s in meta.get("services", []) or []:
        if s.get("id") == on_host and s.get("kind") == "vps":
            return s
    return None


def _find_db_service(meta: dict, vps_id: str) -> dict | None:
    """Busca el primer service kind=postgres alojado en la misma VPS."""
    for s in meta.get("services", []) or []:
        if s.get("kind") == "postgres" and (s.get("config") or {}).get("on_host") == vps_id:
            return s
    return None
```

### Step 2.3 — Probe VPS (reusa parse_report)

```python
def probe_vps(vps_service: dict) -> dict:
    host = _build_host_from_vps(vps_service)
    code, raw, err = ssh_run(host, build_collector(host), timeout=DETAIL_TIMEOUT)
    if code != 0:
        return {"error": (err or "").strip()[:300] or f"ssh exit {code}", "data": None}
    return {"error": None, "data": parse_report(raw, host)}
```

### Step 2.4 — Probe n8n

```python
N8N_PROBE_TMPL = r'''set +e
export LC_ALL=C
CONT="$(printf %s '__CONT_B64__' | base64 -d 2>/dev/null)"
DBC="$(printf %s '__DBC_B64__' | base64 -d 2>/dev/null)"
DBU="$(printf %s '__DBU_B64__' | base64 -d 2>/dev/null)"
DBN="$(printf %s '__DBN_B64__' | base64 -d 2>/dev/null)"
DBP="$(printf %s '__DBP_B64__' | base64 -d 2>/dev/null)"
resolve_container() {
  [ -n "$1" ] && command -v docker >/dev/null || return 0
  docker ps --format '{{.Names}}' | grep -E "^$1(\.|\$)" | head -1
}
N8C="$(resolve_container "$CONT")"
DBC2="$(resolve_container "$DBC")"
psqlq() { docker exec -e PGPASSWORD="$DBP" "$DBC2" psql -U "$DBU" -d "$DBN" -tAF '|' -c "$1" 2>&1; }
echo "@@health"
if [ -n "$N8C" ]; then
  docker exec "$N8C" wget -q -S -O /dev/null http://localhost:5678/healthz 2>&1 | grep -oE 'HTTP/[0-9.]+ [0-9]+' | grep -oE '[0-9]+$' | head -1
fi
echo "@@container"
if [ -n "$N8C" ]; then docker ps --format '{{json .}}' --filter "name=^$N8C\$" | head -1; fi
echo "@@workflows"
[ -n "$DBC2" ] && [ -n "$DBN" ] && psqlq "SELECT id, name, active::text, to_char(\"updatedAt\",'YYYY-MM-DD HH24:MI') FROM workflow_entity ORDER BY \"updatedAt\" DESC LIMIT 50"
echo "@@recent"
[ -n "$DBC2" ] && [ -n "$DBN" ] && psqlq "SELECT e.id, COALESCE(w.name,'(borrado)'), COALESCE(e.status::text, CASE WHEN e.finished THEN 'success' ELSE 'unknown' END), to_char(e.\"startedAt\",'YYYY-MM-DD HH24:MI'), e.mode FROM execution_entity e LEFT JOIN workflow_entity w ON w.id::text=e.\"workflowId\"::text ORDER BY e.\"startedAt\" DESC LIMIT 30"
echo "@@end"
'''


def _b64(s: str) -> str:
    return base64.b64encode(str(s or "").encode()).decode()


def probe_n8n(vps_service: dict, n8n_service: dict, meta: dict) -> dict:
    host = _build_host_from_vps(vps_service)
    n_cfg = n8n_service.get("config") or {}
    container = n_cfg.get("container") or "n8n"
    db_svc = _find_db_service(meta, vps_service["id"])
    db_cfg = (db_svc or {}).get("config") or {}
    script = (N8N_PROBE_TMPL
              .replace("__CONT_B64__", _b64(container))
              .replace("__DBC_B64__", _b64(db_cfg.get("container") or "postgres"))
              .replace("__DBU_B64__", _b64(db_cfg.get("db_user") or "postgres"))
              .replace("__DBN_B64__", _b64(db_cfg.get("db_name") or "n8n"))
              .replace("__DBP_B64__", _b64(db_cfg.get("db_password") or "")))
    code, raw, err = ssh_run(host, script, timeout=DETAIL_TIMEOUT)
    if code != 0:
        return {"error": (err or "").strip()[:300] or f"ssh exit {code}", "data": None}
    sec = _split_sections(raw)
    health = _txt(sec, "health")
    container_raw = _txt(sec, "container")
    container_info = None
    if container_raw.startswith("{"):
        try:
            j = json.loads(container_raw)
            container_info = {"name": j.get("Names", ""), "image": j.get("Image", ""),
                              "status": j.get("Status", ""), "state": j.get("State", "")}
        except json.JSONDecodeError:
            pass
    workflows = []
    wf_raw = _txt(sec, "workflows")
    if not _psql_failed(wf_raw):
        for line in wf_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 4:
                workflows.append({"id": parts[0].strip(), "name": parts[1].strip(),
                                  "active": parts[2].strip() == "true",
                                  "updated": parts[3].strip()})
    recent = []
    rec_raw = _txt(sec, "recent")
    if not _psql_failed(rec_raw):
        for line in rec_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 5:
                recent.append({"id": parts[0].strip(), "workflow": parts[1].strip(),
                               "status": parts[2].strip(), "started": parts[3].strip(),
                               "mode": parts[4].strip()})
    return {"error": None, "data": {
        "health": health, "health_ok": health == "200",
        "container": container_info,
        "workflows": workflows, "recent": recent,
    }}
```

### Step 2.5 — Probe postgres

```python
PG_PROBE_TMPL = r'''set +e
export LC_ALL=C
CONT="$(printf %s '__CONT_B64__' | base64 -d 2>/dev/null)"
DBU="$(printf %s '__DBU_B64__' | base64 -d 2>/dev/null)"
DBN="$(printf %s '__DBN_B64__' | base64 -d 2>/dev/null)"
DBP="$(printf %s '__DBP_B64__' | base64 -d 2>/dev/null)"
resolve_container() {
  [ -n "$1" ] && command -v docker >/dev/null || return 0
  docker ps --format '{{.Names}}' | grep -E "^$1(\.|\$)" | head -1
}
DBC="$(resolve_container "$CONT")"
psqlq() { docker exec -e PGPASSWORD="$DBP" "$DBC" psql -U "$DBU" -d "$DBN" -tAF '|' -c "$1" 2>&1; }
echo "@@isready";    [ -n "$DBC" ] && docker exec "$DBC" pg_isready 2>&1
echo "@@size";       psqlq "SELECT pg_size_pretty(pg_database_size(current_database()))"
echo "@@conns";      psqlq "SELECT count(*) FROM pg_stat_activity"
echo "@@version";    psqlq "SHOW server_version"
echo "@@active";     psqlq "SELECT pid, COALESCE(state,''), to_char(query_start,'YYYY-MM-DD HH24:MI'), substr(query,1,80) FROM pg_stat_activity WHERE state IS NOT NULL AND state != 'idle' AND pid != pg_backend_pid() ORDER BY query_start LIMIT 10"
echo "@@tables";     psqlq "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2"
echo "@@columns";    psqlq "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,ordinal_position"
echo "@@fks";        psqlq "SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_schema, ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name WHERE tc.constraint_type='FOREIGN KEY'"
echo "@@end"
'''


def probe_postgres(vps_service: dict, pg_service: dict) -> dict:
    host = _build_host_from_vps(vps_service)
    cfg = pg_service.get("config") or {}
    container = cfg.get("container") or "postgres"
    db_user = cfg.get("db_user") or "postgres"
    db_name = cfg.get("db_name") or "postgres"
    db_pass = cfg.get("db_password") or ""
    script = (PG_PROBE_TMPL
              .replace("__CONT_B64__", _b64(container))
              .replace("__DBU_B64__", _b64(db_user))
              .replace("__DBN_B64__", _b64(db_name))
              .replace("__DBP_B64__", _b64(db_pass)))
    code, raw, err = ssh_run(host, script, timeout=DETAIL_TIMEOUT)
    if code != 0:
        return {"error": (err or "").strip()[:300] or f"ssh exit {code}", "data": None}
    sec = _split_sections(raw)
    isready = _txt(sec, "isready")
    size = _txt(sec, "size")
    conns = _txt(sec, "conns")
    version = _txt(sec, "version")
    active = []
    a_raw = _txt(sec, "active")
    if not _psql_failed(a_raw):
        for line in a_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 4:
                active.append({"pid": parts[0].strip(), "state": parts[1].strip(),
                               "since": parts[2].strip(), "query": parts[3].strip()})
    # Tablas + columnas
    tables_idx = {}  # (schema, name) → table dict
    truncated = False
    t_raw = _txt(sec, "tables")
    if not _psql_failed(t_raw):
        for line in t_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 2:
                key = (parts[0].strip(), parts[1].strip())
                if len(tables_idx) >= SCHEMA_TABLE_CAP:
                    truncated = True
                    break
                tables_idx[key] = {"schema": key[0], "name": key[1], "columns": []}
    c_raw = _txt(sec, "columns")
    col_count = 0
    if not _psql_failed(c_raw):
        for line in c_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 5:
                key = (parts[0].strip(), parts[1].strip())
                if key in tables_idx:
                    if col_count >= SCHEMA_COLUMN_CAP:
                        truncated = True
                        break
                    tables_idx[key]["columns"].append({
                        "name": parts[2].strip(),
                        "type": parts[3].strip(),
                        "nullable": parts[4].strip() == "YES",
                    })
                    col_count += 1
    fks = []
    fk_raw = _txt(sec, "fks")
    if not _psql_failed(fk_raw):
        for line in fk_raw.splitlines():
            parts = line.split("|")
            if len(parts) >= 6:
                fks.append({
                    "from_schema": parts[0].strip(), "from_table": parts[1].strip(),
                    "from_column": parts[2].strip(),
                    "to_schema": parts[3].strip(), "to_table": parts[4].strip(),
                    "to_column": parts[5].strip(),
                })
    return {"error": None, "data": {
        "stats": {
            "isready": isready,
            "ready": "accepting connections" in isready,
            "size": None if _psql_failed(size) else size,
            "conns": int(conns) if conns.isdigit() else None,
            "version": None if _psql_failed(version) else version,
            "active_queries": active,
        },
        "schema": {
            "tables": list(tables_idx.values()),
            "fks": fks,
            "truncated": truncated,
        },
    }}
```

### Step 2.6 — Probe container logs (chatwoot, backoffice, app)

```python
LOGS_PROBE_TMPL = r'''set +e
export LC_ALL=C
CONT="$(printf %s '__CONT_B64__' | base64 -d 2>/dev/null)"
HURL="$(printf %s '__HURL_B64__' | base64 -d 2>/dev/null)"
TAIL="__TAIL__"
resolve_container() {
  [ -n "$1" ] && command -v docker >/dev/null || return 0
  docker ps -a --format '{{.Names}}' | grep -E "^$1(\.|\$)" | head -1
}
C="$(resolve_container "$CONT")"
echo "@@container"
if [ -n "$C" ]; then docker ps -a --format '{{json .}}' --filter "name=^$C\$" | head -1; fi
echo "@@inspect"
if [ -n "$C" ]; then docker inspect --format '{{json .State}}' "$C" 2>&1 | head -1; fi
echo "@@logs"
if [ -n "$C" ]; then docker logs --tail "$TAIL" --timestamps "$C" 2>&1; fi
echo "@@health"
if [ -n "$HURL" ]; then curl -s -m 3 -o /dev/null -w '%{http_code}' "$HURL" 2>/dev/null || echo "err"; fi
echo "@@end"
'''


def probe_container_logs(vps_service: dict, target_service: dict) -> dict:
    host = _build_host_from_vps(vps_service)
    cfg = target_service.get("config") or {}
    container = cfg.get("container") or target_service.get("kind") or ""
    health_url = cfg.get("health_url") or ""
    script = (LOGS_PROBE_TMPL
              .replace("__CONT_B64__", _b64(container))
              .replace("__HURL_B64__", _b64(health_url))
              .replace("__TAIL__", str(LOGS_TAIL)))
    code, raw, err = ssh_run(host, script, timeout=DETAIL_TIMEOUT)
    if code != 0:
        return {"error": (err or "").strip()[:300] or f"ssh exit {code}", "data": None}
    sec = _split_sections(raw)
    container_info = None
    c_raw = _txt(sec, "container")
    if c_raw.startswith("{"):
        try:
            j = json.loads(c_raw)
            container_info = {"name": j.get("Names", ""), "image": j.get("Image", ""),
                              "status": j.get("Status", ""), "state": j.get("State", "")}
        except json.JSONDecodeError:
            pass
    state_info = None
    s_raw = _txt(sec, "inspect")
    if s_raw.startswith("{"):
        try:
            state_info = json.loads(s_raw)
        except json.JSONDecodeError:
            pass
    logs = _txt(sec, "logs")
    health = _txt(sec, "health") or None
    return {"error": None, "data": {
        "container": container_info,
        "state": state_info,
        "logs": logs,
        "logs_lines": len(logs.splitlines()) if logs else 0,
        "health_url": health_url or None,
        "health_status": health,
    }}
```

### Step 2.7 — Orquestador con cache

```python
def get_service_detail(client: str, project: str, service_id: str) -> dict:
    """Devuelve detalle del servicio. Cachea por service_id con TTL DETAIL_TTL."""
    now = time.time()
    with DETAIL_LOCK:
        cached = DETAIL_CACHE.get(service_id)
    if cached and (now - cached["ts"]) < DETAIL_TTL:
        return cached["data"]

    meta = load_project_meta(client, project)
    service = _find_service(meta, service_id)
    if not service:
        return {"error": "service no encontrado", "data": None,
                "service": None, "host_vps": None, "ts": now}
    host_vps = _find_host_vps(meta, service)
    if not host_vps:
        return {"error": "VPS host no encontrado", "data": None,
                "service": service, "host_vps": None, "ts": now}

    kind = service.get("kind")
    role = (service.get("config") or {}).get("role") or kind

    if kind == "vps":
        result = probe_vps(service)
    elif kind == "n8n":
        result = probe_n8n(host_vps, service, meta)
    elif kind == "postgres":
        result = probe_postgres(host_vps, service)
    elif kind == "chatwoot" or kind == "docker" or role in ("backoffice", "app", "chatwoot"):
        result = probe_container_logs(host_vps, service)
    elif kind in ("github", "linear"):
        result = {"error": None, "data": {"kind": "saas",
                                          "config": service.get("config") or {}}}
    else:
        result = {"error": f"kind {kind} sin probe", "data": None}

    response = {
        "service": {"id": service["id"], "kind": service["kind"], "name": service["name"]},
        "host_vps": {"id": host_vps["id"], "name": host_vps["name"]},
        "ts": now,
        "data": result["data"],
        "error": result["error"],
    }
    with DETAIL_LOCK:
        DETAIL_CACHE[service_id] = {"ts": now, "data": response}
    return response
```

### Checkpoint Task 2

No verificación directa (lo cubre Task 3 que expone el endpoint).

---

## Task 3 — Backend: endpoint `/api/services/detail`

**Files:**
- Modify: `backend/server.py` (do_GET branch + nuevo handler `_service_detail`)

### Step 3.1 — Añadir ruta al do_GET

Buscar el bloque que lista `/api/projects/health` (≈ línea 1156) y añadir `/api/services/detail`:

```python
elif path in ("/api/clients", "/api/projects", "/api/repos",
              "/api/repos/branches", "/api/projects/meta", "/api/world",
              "/api/projects/health", "/api/services/detail"):
    # ...
    elif path == "/api/projects/health":
        self._projects_health(q.get("client", [""])[0], q.get("project", [""])[0])
    elif path == "/api/services/detail":
        self._service_detail(q.get("client", [""])[0],
                             q.get("project", [""])[0],
                             q.get("service", [""])[0])
```

### Step 3.2 — Handler

Añadir cerca de `_projects_health`:

```python
def _service_detail(self, client: str, project: str, service: str):
    if not client or not project or not service:
        return self._json(400, {"error": "client/project/service requeridos"})
    if not (valid_name(client) and valid_name(project)):
        return self._json(400, {"error": "nombre inválido"})
    try:
        resp = get_service_detail(client, project, service)
    except ValueError as e:
        return self._json(400, {"error": str(e)})
    except Exception as e:
        return self._json(500, {"error": f"detail error: {e}"})
    return self._json(200, resp)
```

### Checkpoint Task 3

```bash
# (con backend corriendo en :8788 y cookie de auth válida en $TOK)
curl -s -b "auth=$TOK" "http://127.0.0.1:8788/api/services/detail?client=DiveAcademy&project=Panel&service=vps-XXX" | python3 -m json.tool | head -30
```

Debería devolver `service`, `host_vps`, `data.system.cpu_pct`, etc.

NO commit aún.

---

## Task 4 — Backend: evaluador de alertas + endpoints

**Files:**
- Modify: `backend/server.py` (ALERT_STATE, evaluate_alerts, enganche en health_poll_loop, handlers HTTP)

### Step 4.1 — Estado de alertas + evaluador

Añadir después del bloque F8 de probes:

```python
# ============================================================ #
# Fase 8 — Evaluador de alertas                                 #
# ============================================================ #
ALERT_STATE = {}                # rule_id → {firing, since, last_check, reason, ...}
ALERT_LOCK = threading.Lock()


def _last_parse_for_vps(vps_id: str) -> dict | None:
    """Si tenemos un DETAIL_CACHE reciente del VPS, devuelve su parse_report."""
    with DETAIL_LOCK:
        entry = DETAIL_CACHE.get(vps_id)
    if not entry:
        return None
    return (entry.get("data") or {}).get("data")


def _eval_rule(rule: dict, service: dict, host_vps: dict, meta: dict) -> tuple[bool, str]:
    """Devuelve (firing, reason)."""
    kind = rule["kind"]
    threshold = rule.get("threshold")
    vps_id = host_vps["id"] if host_vps else None

    if kind in ("cpu_above", "ram_above", "disk_above"):
        with HEALTH_LOCK:
            h = HEALTH_CACHE.get(service["id"]) if service.get("kind") == "vps" else None
        if not h or not h.get("metrics"):
            return False, "sin métricas"
        m = h["metrics"]
        if kind == "cpu_above" and m.get("cpu_pct", 0) > threshold:
            return True, f"CPU {m['cpu_pct']:.0f}% > {threshold:.0f}%"
        if kind == "ram_above" and m.get("ram_pct", 0) > threshold:
            return True, f"RAM {m['ram_pct']:.0f}% > {threshold:.0f}%"
        if kind == "disk_above" and m.get("disk_pct_max", 0) > threshold:
            return True, f"Disk {m['disk_pct_max']:.0f}% > {threshold:.0f}%"
        return False, ""

    if kind == "container_down":
        cfg = service.get("config") or {}
        wanted = (cfg.get("container") or service.get("kind") or "").strip()
        if not wanted:
            return False, "container no declarado"
        parsed = _last_parse_for_vps(vps_id) if vps_id else None
        if not parsed:
            with HEALTH_LOCK:
                hv = HEALTH_CACHE.get(vps_id)
            if hv and hv.get("status") == "down":
                return True, "VPS host down"
            return False, "sin datos de container"
        conts = (parsed.get("docker") or {}).get("containers", [])
        for c in conts:
            name = c.get("name", "")
            if name == wanted or name.startswith(wanted + "."):
                state = (c.get("state") or "").lower()
                status = (c.get("status") or "").lower()
                if state == "running" or status.startswith("up"):
                    return False, ""
                return True, f"{name} state={state or 'desconocido'}"
        return True, f"container {wanted} no encontrado"

    if kind == "n8n_workflow_failed":
        parsed = _last_parse_for_vps(vps_id) if vps_id else None
        if not parsed:
            return False, "sin datos n8n"
        recent = (parsed.get("n8n") or {}).get("recent", [])
        if not recent:
            return False, "sin ejecuciones"
        last = recent[0]
        if (last.get("status") or "").lower() == "error":
            return True, f"workflow {last.get('workflow','?')} falló"
        return False, ""

    if kind == "health_url_not_2xx":
        cfg = service.get("config") or {}
        url = cfg.get("health_url")
        if not url:
            return False, "health_url no declarado"
        if not host_vps:
            return False, "sin host"
        host = _build_host_from_vps(host_vps)
        code, raw, err = ssh_run(host,
            f'curl -s -m 3 -o /dev/null -w "%{{http_code}}" "{url}"',
            timeout=10)
        if code != 0:
            return True, f"ssh err: {(err or '').strip()[:60]}"
        status = raw.strip()
        if status.startswith("2"):
            return False, ""
        return True, f"HTTP {status or '???'}"

    return False, "kind desconocido"


def evaluate_alerts():
    """Recorre todos los proyectos, lee sus .alerts.json, evalúa contra
    HEALTH_CACHE/DETAIL_CACHE, actualiza ALERT_STATE."""
    for client_dir in PROJECTS.iterdir():
        if not client_dir.is_dir() or not valid_name(client_dir.name):
            continue
        for proj_dir in client_dir.iterdir():
            if not proj_dir.is_dir() or not valid_name(proj_dir.name):
                continue
            client, project = client_dir.name, proj_dir.name
            try:
                alerts = load_alerts(client, project)
                meta = load_project_meta(client, project)
            except (ValueError, OSError):
                continue
            for rule in alerts.get("rules", []):
                if not rule.get("enabled", True):
                    continue
                rid = rule.get("id")
                if not rid:
                    continue
                service = _find_service(meta, rule.get("service_id", ""))
                if not service:
                    continue
                host_vps = _find_host_vps(meta, service)
                try:
                    firing, reason = _eval_rule(rule, service, host_vps, meta)
                except Exception as e:
                    firing, reason = False, f"eval error: {e}"
                now = time.time()
                with ALERT_LOCK:
                    prev = ALERT_STATE.get(rid)
                    if firing and not (prev and prev.get("firing")):
                        ALERT_STATE[rid] = {
                            "rule_id": rid,
                            "firing": True,
                            "since": now,
                            "last_check": now,
                            "reason": reason,
                            "client": client,
                            "project": project,
                            "service_id": rule.get("service_id"),
                            "service_name": service.get("name"),
                            "kind": rule.get("kind"),
                            "label": rule.get("label"),
                        }
                    elif firing:
                        ALERT_STATE[rid]["last_check"] = now
                        ALERT_STATE[rid]["reason"] = reason
                    elif prev and prev.get("firing"):
                        ALERT_STATE[rid]["firing"] = False
                        ALERT_STATE[rid]["last_check"] = now
```

### Step 4.2 — Enganchar evaluador al `health_poll_loop`

En `health_poll_loop`, después del bloque que actualiza `HEALTH_CACHE`, justo antes del `time.sleep`, añadir:

```python
try:
    evaluate_alerts()
except Exception as e:
    print(f"[health-poll] eval alerts error: {e}")
```

### Step 4.3 — Handlers HTTP

```python
def _projects_alerts_get(self, c: str, p: str):
    if not (valid_name(c) and valid_name(p)):
        return self._json(400, {"error": "nombre inválido"})
    try:
        rules = load_alerts(c, p).get("rules", [])
    except Exception as e:
        return self._json(500, {"error": str(e)})
    with ALERT_LOCK:
        state = {rid: dict(v) for rid, v in ALERT_STATE.items()
                 if v.get("client") == c and v.get("project") == p}
    return self._json(200, {"rules": rules, "state": state})


def _projects_alerts_post(self, c: str, p: str, body: bytes):
    if not (valid_name(c) and valid_name(p)):
        return self._json(400, {"error": "nombre inválido"})
    try:
        payload = json.loads(body.decode() or "{}")
    except json.JSONDecodeError:
        return self._json(400, {"error": "json inválido"})
    normalized, err = validate_alerts_payload(payload)
    if normalized is None:
        return self._json(400, {"error": err})
    try:
        save_alerts(c, p, normalized)
    except Exception as e:
        return self._json(500, {"error": str(e)})
    # Limpia ALERT_STATE de reglas eliminadas
    keep = {r["id"] for r in normalized["rules"]}
    with ALERT_LOCK:
        for rid in list(ALERT_STATE.keys()):
            if ALERT_STATE[rid].get("client") == c and ALERT_STATE[rid].get("project") == p \
                    and rid not in keep:
                ALERT_STATE.pop(rid, None)
    return self._json(200, {"ok": True, "rules": normalized["rules"]})


def _alerts_active(self):
    with ALERT_LOCK:
        firing = [dict(v) for v in ALERT_STATE.values() if v.get("firing")]
    firing.sort(key=lambda x: x.get("since", 0))
    return self._json(200, {"alerts": firing})
```

### Step 4.4 — Rutas GET y POST

Añadir a la lista de paths GET autenticados:

```python
elif path in ("/api/clients", ..., "/api/services/detail",
              "/api/projects/alerts", "/api/alerts/active"):
    # ...
    elif path == "/api/projects/alerts":
        self._projects_alerts_get(q.get("client", [""])[0], q.get("project", [""])[0])
    elif path == "/api/alerts/active":
        self._alerts_active()
```

Para el POST, en `do_POST` (cerca de otros POST autenticados), añadir:

```python
if self.path.startswith("/api/projects/alerts"):
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
    length = int(self.headers.get("Content-Length", "0"))
    body = self.rfile.read(length) if length > 0 else b""
    return self._projects_alerts_post(q.get("client", [""])[0],
                                      q.get("project", [""])[0], body)
```

### Checkpoint Task 4

```bash
# (con backend reiniciado)
curl -s -b "auth=$TOK" 'http://127.0.0.1:8788/api/alerts/active' | python3 -m json.tool
# → {"alerts": []}

curl -s -b "auth=$TOK" -X POST 'http://127.0.0.1:8788/api/projects/alerts?client=test-client&project=test-project' \
  -H 'Content-Type: application/json' \
  --data '{"rules":[{"service_id":"<id-vps-real>","kind":"cpu_above","threshold":0,"label":"Test"}]}' \
  | python3 -m json.tool

# Esperar ~30s al siguiente poll:
curl -s -b "auth=$TOK" 'http://127.0.0.1:8788/api/alerts/active' | python3 -m json.tool
# → debería listar la alerta firing
```

NO commit aún.

---

## Task 5 — Frontend: vista detalle (estado + render)

**Files:**
- Modify: `frontend/map2d.js` (estado viewMode, enterDetail/exitDetail, renderVpsDetailView)
- Modify: `frontend/map2d.css` (estilos vista detalle)
- Modify: `frontend/index.html` (slot `#vps-detail-view` dentro de `#map-home`)

### Step 5.1 — index.html: slot para la vista detalle

Buscar `#map-grid` dentro de `#map-home` y añadir hermano:

```html
<div id="vps-detail-view" class="hidden"></div>
```

### Step 5.2 — map2d.js: estado y switch

Al principio de map2d.js, sustituir el bloque de estado:

```js
let mapData = null;
let healthCache = new Map();
let pollTimer = null;
let expandedVpsIds = new Set();

// Fase 8: vista detalle
let viewMode = "grid";          // "grid" | "detail"
let detailVpsId = null;         // id del VPS actualmente en detalle
let detailServiceId = null;     // service id del drawer abierto (null = cerrado)
let activeAlerts = [];          // último snapshot de alertas firing
```

Modificar `loadAndRender` para respetar `viewMode`:

```js
async function loadAndRender() {
  try {
    const r = await fetch("/api/world");
    if (!r.ok) throw new Error("HTTP " + r.status);
    mapData = await r.json();
    await fetchAllHealth();
    await fetchActiveAlerts();
    if (viewMode === "detail" && detailVpsId) {
      renderVpsDetailView();
    } else {
      renderGrid();
    }
  } catch (e) {
    console.error("loadAndRender:", e);
  }
}
```

### Step 5.3 — Funciones enterDetail / exitDetail

Añadir tras `bindStaticHandlers`:

```js
function enterDetail(vpsId) {
  viewMode = "detail";
  detailVpsId = vpsId;
  detailServiceId = null;
  document.getElementById("map-grid").classList.add("hidden");
  document.querySelectorAll(".map-client").forEach(el => el.classList.add("hidden"));
  const view = document.getElementById("vps-detail-view");
  if (view) view.classList.remove("hidden");
  renderVpsDetailView();
}

function exitDetail() {
  viewMode = "grid";
  detailVpsId = null;
  detailServiceId = null;
  closeServiceDrawer();
  const view = document.getElementById("vps-detail-view");
  if (view) view.classList.add("hidden");
  document.getElementById("map-grid").classList.remove("hidden");
  renderGrid();
}

function findVpsItem(vpsId) {
  const all = collectAllVps();
  return all.find(i => i.vps.id === vpsId);
}

function renderVpsDetailView() {
  const view = document.getElementById("vps-detail-view");
  if (!view) return;
  const item = findVpsItem(detailVpsId);
  if (!item) { exitDetail(); return; }
  const health = healthCache.get(item.vps.id) || { status: "down", error: "sin datos" };
  const statusIcon = { ok: "🟢", warn: "⚠️", down: "⛔" }[health.status] || "⛔";
  const metrics = health.metrics;
  const metricsLine = metrics
    ? `CPU ${Math.round(metrics.cpu_pct)}% · RAM ${Math.round(metrics.ram_pct)}% · Disk ${Math.round(metrics.disk_pct_max)}%`
    : (health.error || "sin datos");
  const alertCount = activeAlerts.filter(a => a.service_id === item.vps.id
    || item.hostedServices.some(s => s.id === a.service_id)).length;
  const alertBadge = alertCount > 0
    ? `<span class="alert-badge">${alertCount} alerta${alertCount>1?'s':''}</span>` : "";

  let html = `
    <header class="detail-header">
      <button class="btn detail-back" id="detail-back-btn">← Volver al mapa</button>
      <h2>VPS: ${esc(item.vps.name)}</h2>
      <span class="status-icon">${statusIcon}</span>
      ${alertBadge}
    </header>
    <section class="detail-center" data-service-id="${esc(item.vps.id)}" data-action="open-svc">
      <div class="detail-center-title">VPS</div>
      <div class="detail-center-name">${esc(item.vps.name)}</div>
      <div class="detail-center-metrics">${esc(metricsLine)}</div>
      <div class="detail-center-hint">click para ver detalle del sistema →</div>
    </section>
    <section class="detail-tiles">
      ${item.hostedServices.map(s => renderTile(s, item.vps.id)).join("") || '<div class="muted">(sin servicios alojados)</div>'}
    </section>`;
  if (item.satellites.length > 0) {
    html += `<section class="detail-satellites">
      <h4>Satélites SaaS</h4>
      ${item.satellites.map(s => renderTile(s, item.vps.id, true)).join("")}
    </section>`;
  }
  html += `<aside id="svc-drawer" class="hidden"></aside>`;
  view.innerHTML = html;
  bindDetailHandlers();
  if (detailServiceId) {
    openServiceDrawer(detailServiceId);
  }
}

function renderTile(svc, vpsId, isSatellite=false) {
  const kindColors = {
    vps:"#8b949e", n8n:"#a371f7", docker:"#2496ed", chatwoot:"#f48120",
    postgres:"#336791", github:"#e6edf3", linear:"#5e6ad2", custom:"#6e7681"
  };
  const color = kindColors[svc.kind] || kindColors.custom;
  const role = (svc.config && svc.config.role) || svc.kind;
  return `
    <div class="detail-tile ${isSatellite ? 'detail-tile-sat' : ''}"
         data-service-id="${esc(svc.id)}" data-action="open-svc"
         style="border-left: 4px solid ${color}">
      <div class="tile-kind">${esc(svc.kind)}</div>
      <div class="tile-name">${esc(svc.name)}</div>
      <div class="tile-role muted">${esc(role)}</div>
    </div>`;
}

function bindDetailHandlers() {
  const back = document.getElementById("detail-back-btn");
  if (back) back.onclick = exitDetail;
  document.querySelectorAll('[data-action="open-svc"]').forEach(el => {
    el.onclick = () => openServiceDrawer(el.dataset.serviceId);
  });
}
```

### Step 5.4 — Cambiar el handler del click en card body

En `bindCardHandlers`, añadir:

```js
document.querySelectorAll(".vps-card").forEach(card => {
  card.querySelectorAll(".vps-mini-map, .vps-metrics").forEach(el => {
    el.style.cursor = "zoom-in";
    el.onclick = (ev) => {
      ev.stopPropagation();
      const id = card.dataset.vpsId;
      enterDetail(id);
    };
  });
});
```

### Step 5.5 — Estilos en map2d.css

Añadir al final:

```css
/* Fase 8 — Vista detalle */
.hidden { display: none !important; }

#vps-detail-view {
  padding: 0 4px;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0 16px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 18px;
}
.detail-header h2 { margin: 0; font-size: 18px; flex: 1; }
.detail-back { font-size: 13px; }
.alert-badge {
  background: #ef4444; color: white; font-size: 11px;
  padding: 3px 8px; border-radius: 10px; font-weight: 600;
}

.detail-center {
  margin: 0 auto 24px auto;
  max-width: 320px;
  background: var(--tool);
  border: 2px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  cursor: zoom-in;
  transition: border-color 200ms;
}
.detail-center:hover { border-color: #d4a017; }
.detail-center-title { font-size: 11px; text-transform: uppercase;
  letter-spacing: 1px; color: var(--muted); }
.detail-center-name { font-size: 20px; font-weight: 600; margin: 6px 0; }
.detail-center-metrics { font-family: monospace; font-size: 13px; margin: 8px 0; }
.detail-center-hint { font-size: 11px; color: var(--muted); font-style: italic; }

.detail-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.detail-tile {
  background: var(--tool);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: transform 150ms, border-color 150ms;
}
.detail-tile:hover { transform: translateY(-2px); border-color: #d4a017; }
.tile-kind { font-size: 11px; text-transform: uppercase; color: var(--muted); }
.tile-name { font-size: 14px; font-weight: 600; margin: 4px 0; color: var(--text); }
.tile-role { font-size: 11px; }

.detail-satellites { margin-bottom: 24px; }
.detail-satellites h4 { font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.5px; color: var(--muted); margin: 0 0 8px 0; }
.detail-tile-sat { opacity: 0.85; }

/* Drawer */
#svc-drawer {
  position: fixed;
  top: 64px;
  right: 0;
  width: min(520px, 95vw);
  height: calc(100vh - 64px);
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -4px 0 24px rgba(0,0,0,0.4);
  padding: 16px;
  overflow-y: auto;
  z-index: 100;
}
.drawer-header {
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 12px; border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.drawer-header h3 { margin: 0; flex: 1; font-size: 15px; }
.drawer-close { background: transparent; border: 0; color: var(--text);
  font-size: 22px; cursor: pointer; padding: 0 6px; }
.drawer-loading, .drawer-error { padding: 24px; text-align: center; color: var(--muted); }
.drawer-error { color: #ef4444; }

.drawer-section { margin: 14px 0; }
.drawer-section h4 { font-size: 11px; text-transform: uppercase;
  color: var(--muted); margin: 0 0 6px 0; }
.drawer-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.drawer-table th, .drawer-table td {
  text-align: left; padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  font-family: monospace;
}
.drawer-table th { color: var(--muted); font-weight: 500; font-size: 11px; }
.drawer-logs {
  background: #0a0a0a; color: #c9d1d9;
  font-family: monospace; font-size: 11px; line-height: 1.4;
  padding: 8px; border-radius: 4px;
  max-height: 280px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}
.drawer-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 10px; }
.drawer-tab {
  background: transparent; border: 0; padding: 6px 10px;
  color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent;
  font-size: 12px;
}
.drawer-tab.active { color: var(--text); border-bottom-color: #d4a017; }
.health-pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 11px; font-weight: 600;
}
.health-pill-ok { background: rgba(34,197,94,0.15); color: #22c55e; }
.health-pill-bad { background: rgba(239,68,68,0.15); color: #ef4444; }
```

### Checkpoint Task 5

- Reiniciar backend. Refrescar navegador en `http://127.0.0.1:8788`.
- En el mapa, click en la métrica o mini-map de una card → debe aparecer la vista detalle con el VPS centro + tiles.
- Click en "Volver al mapa" → vuelve al grid.
- (Tiles aún no abren drawer — eso es Task 6.)

---

## Task 6 — Frontend: drawer + renderers por kind

**Files:**
- Modify: `frontend/map2d.js`

### Step 6.1 — openServiceDrawer / closeServiceDrawer

Añadir tras `bindDetailHandlers`:

```js
async function openServiceDrawer(serviceId) {
  detailServiceId = serviceId;
  const drawer = document.getElementById("svc-drawer");
  if (!drawer) return;
  drawer.classList.remove("hidden");
  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>Cargando…</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    <div class="drawer-loading">Consultando VPS por SSH…</div>`;
  document.getElementById("drawer-close-btn").onclick = closeServiceDrawer;

  const item = findVpsItem(detailVpsId);
  if (!item) { closeServiceDrawer(); return; }
  // Localiza client/project del VPS
  let clientName = "", projectName = "";
  for (const cli of (mapData.clients || [])) {
    for (const proj of (cli.projects || [])) {
      const services = (proj.meta && proj.meta.services) || [];
      if (services.some(s => s.id === detailVpsId)) {
        clientName = cli.name; projectName = proj.name; break;
      }
    }
    if (clientName) break;
  }
  const url = `/api/services/detail?client=${encodeURIComponent(clientName)}` +
              `&project=${encodeURIComponent(projectName)}` +
              `&service=${encodeURIComponent(serviceId)}`;
  let resp;
  try {
    const r = await fetch(url);
    resp = await r.json();
  } catch (e) {
    drawer.innerHTML = renderDrawerError("fetch error: " + e.message);
    bindDrawerCloseAgain();
    return;
  }
  if (resp.error) {
    drawer.innerHTML = renderDrawerError(resp.error);
    bindDrawerCloseAgain();
    return;
  }
  const svc = resp.service;
  const kind = svc.kind;
  let body = "";
  if (kind === "vps") body = renderVpsDrawer(resp.data);
  else if (kind === "n8n") body = renderN8nDrawer(resp.data);
  else if (kind === "postgres") body = renderPostgresDrawer(resp.data);
  else if (kind === "chatwoot" || kind === "docker") body = renderLogsDrawer(resp.data);
  else if (kind === "github" || kind === "linear") body = renderSaasDrawer(resp.data);
  else body = `<div class="drawer-section">Sin renderer para kind <code>${esc(kind)}</code></div>`;

  drawer.innerHTML = `
    <div class="drawer-header">
      <h3>${esc(svc.kind)} · ${esc(svc.name)}</h3>
      <button class="drawer-close" id="drawer-close-btn">✕</button>
    </div>
    ${body}`;
  bindDrawerCloseAgain();
}

function bindDrawerCloseAgain() {
  const x = document.getElementById("drawer-close-btn");
  if (x) x.onclick = closeServiceDrawer;
}

function closeServiceDrawer() {
  detailServiceId = null;
  const drawer = document.getElementById("svc-drawer");
  if (drawer) {
    drawer.classList.add("hidden");
    drawer.innerHTML = "";
  }
}

function renderDrawerError(msg) {
  return `<div class="drawer-header"><h3>Error</h3>
    <button class="drawer-close" id="drawer-close-btn">✕</button></div>
    <div class="drawer-error">${esc(msg)}</div>`;
}
```

### Step 6.2 — renderVpsDrawer

```js
function renderVpsDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const sys = d.system || {};
  const mem = sys.mem || {};
  const top = sys.top || [];
  const docker = d.docker || {};
  const containers = docker.containers || [];
  return `
    <section class="drawer-section">
      <h4>Sistema</h4>
      <table class="drawer-table">
        <tr><td>Host</td><td>${esc(sys.hostname || "-")}</td></tr>
        <tr><td>Kernel</td><td>${esc(sys.kernel || "-")}</td></tr>
        <tr><td>CPU</td><td>${sys.cpu_pct ?? "-"}% (${sys.ncpu ?? "?"} cores)</td></tr>
        <tr><td>RAM</td><td>${mem.pct ?? "-"}% (${fmtBytes(mem.used)}/${fmtBytes(mem.total)})</td></tr>
        <tr><td>Uptime</td><td>${fmtDuration(sys.uptime)}</td></tr>
        <tr><td>Load</td><td>${(sys.loadavg||[]).join(" / ")}</td></tr>
      </table>
    </section>
    <section class="drawer-section">
      <h4>Discos</h4>
      <table class="drawer-table">
        <tr><th>Mount</th><th>Uso</th><th>Total</th></tr>
        ${(sys.disk||[]).map(d => `<tr><td>${esc(d.mount)}</td><td>${d.pct}%</td><td>${fmtBytes(d.size)}</td></tr>`).join("")}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Top procesos</h4>
      <table class="drawer-table">
        <tr><th>PID</th><th>Cmd</th><th>CPU</th><th>MEM</th></tr>
        ${top.map(p => `<tr><td>${esc(p.pid)}</td><td>${esc(p.cmd)}</td><td>${esc(p.cpu)}</td><td>${esc(p.mem)}</td></tr>`).join("")}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Docker (${containers.length})</h4>
      ${docker.available === false
        ? '<div class="muted">docker no disponible</div>'
        : `<table class="drawer-table">
            <tr><th>Nombre</th><th>State</th><th>CPU</th><th>MEM</th></tr>
            ${containers.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.state)}</td><td>${esc(c.cpu||"-")}</td><td>${esc(c.mem||"-")}</td></tr>`).join("")}
          </table>`}
    </section>`;
}

function fmtBytes(n) {
  if (!n) return "-";
  const k = 1024;
  if (n < k) return n + " B";
  if (n < k*k) return (n/k).toFixed(1) + " KB";
  if (n < k*k*k) return (n/k/k).toFixed(1) + " MB";
  return (n/k/k/k).toFixed(2) + " GB";
}
function fmtDuration(s) {
  if (!s) return "-";
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
  return `${d}d ${h}h ${m}m`;
}
```

### Step 6.3 — renderN8nDrawer

```js
function renderN8nDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const health = d.health_ok
    ? '<span class="health-pill health-pill-ok">healthz 200</span>'
    : `<span class="health-pill health-pill-bad">healthz ${esc(d.health || "?")}</span>`;
  const c = d.container || {};
  return `
    <section class="drawer-section">
      <h4>Health</h4>
      ${health}
      ${c.name ? `<div class="muted">container: ${esc(c.name)} (${esc(c.status||c.state||"?")})</div>` : ""}
    </section>
    <section class="drawer-section">
      <h4>Workflows (${(d.workflows||[]).length})</h4>
      <table class="drawer-table">
        <tr><th>Nombre</th><th>Active</th><th>Actualizado</th></tr>
        ${(d.workflows||[]).map(w => `<tr>
          <td>${esc(w.name)}</td>
          <td>${w.active ? '<span class="health-pill health-pill-ok">on</span>' : '<span class="muted">off</span>'}</td>
          <td>${esc(w.updated)}</td>
        </tr>`).join("")}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Ejecuciones recientes (${(d.recent||[]).length})</h4>
      <table class="drawer-table">
        <tr><th>Workflow</th><th>Status</th><th>Cuándo</th><th>Modo</th></tr>
        ${(d.recent||[]).map(e => {
          const pill = e.status === "success"
            ? '<span class="health-pill health-pill-ok">success</span>'
            : e.status === "error"
              ? '<span class="health-pill health-pill-bad">error</span>'
              : esc(e.status);
          return `<tr><td>${esc(e.workflow)}</td><td>${pill}</td><td>${esc(e.started)}</td><td>${esc(e.mode)}</td></tr>`;
        }).join("")}
      </table>
    </section>`;
}
```

### Step 6.4 — renderPostgresDrawer (tabs Monitor / Schema)

```js
let pgDrawerTab = "monitor";

function renderPostgresDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const tabs = `
    <div class="drawer-tabs">
      <button class="drawer-tab ${pgDrawerTab==='monitor'?'active':''}" data-pg-tab="monitor">Monitor</button>
      <button class="drawer-tab ${pgDrawerTab==='schema'?'active':''}" data-pg-tab="schema">Schema</button>
    </div>`;
  const body = pgDrawerTab === "monitor"
    ? renderPgMonitor(d.stats || {})
    : renderPgSchema(d.schema || {});
  setTimeout(() => {
    document.querySelectorAll('[data-pg-tab]').forEach(b => {
      b.onclick = () => { pgDrawerTab = b.dataset.pgTab; openServiceDrawer(detailServiceId); };
    });
  }, 0);
  return tabs + body;
}

function renderPgMonitor(s) {
  const ready = s.ready
    ? '<span class="health-pill health-pill-ok">accepting</span>'
    : `<span class="health-pill health-pill-bad">${esc(s.isready||"down")}</span>`;
  return `
    <section class="drawer-section">
      <h4>Estado</h4>
      ${ready}
      <table class="drawer-table">
        <tr><td>Tamaño</td><td>${esc(s.size||"-")}</td></tr>
        <tr><td>Conexiones</td><td>${s.conns ?? "-"}</td></tr>
        <tr><td>Versión</td><td>${esc(s.version||"-")}</td></tr>
      </table>
    </section>
    <section class="drawer-section">
      <h4>Queries activas (${(s.active_queries||[]).length})</h4>
      <table class="drawer-table">
        <tr><th>PID</th><th>State</th><th>Desde</th><th>Query</th></tr>
        ${(s.active_queries||[]).map(q => `<tr><td>${esc(q.pid)}</td><td>${esc(q.state)}</td><td>${esc(q.since)}</td><td>${esc(q.query)}</td></tr>`).join("")}
      </table>
    </section>`;
}

function renderPgSchema(sch) {
  const tables = sch.tables || [];
  const fks = sch.fks || [];
  const trunc = sch.truncated
    ? '<div class="muted">⚠ schema truncado (cap aplicado)</div>' : "";
  return `
    <section class="drawer-section">
      <h4>Tablas (${tables.length})</h4>
      ${trunc}
      ${renderFkGraph(tables, fks)}
      <div style="margin-top:12px">
        ${tables.map(t => `
          <details>
            <summary>${esc(t.schema)}.${esc(t.name)} (${(t.columns||[]).length} cols)</summary>
            <table class="drawer-table">
              <tr><th>Columna</th><th>Tipo</th><th>Null</th></tr>
              ${(t.columns||[]).map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.type)}</td><td>${c.nullable?"YES":"NO"}</td></tr>`).join("")}
            </table>
          </details>`).join("")}
      </div>
    </section>`;
}

function renderFkGraph(tables, fks) {
  if (tables.length === 0) return "";
  // Layout circular: cap 30 tablas más conectadas
  const degree = {};
  fks.forEach(fk => {
    const a = fk.from_schema+"."+fk.from_table;
    const b = fk.to_schema+"."+fk.to_table;
    degree[a] = (degree[a]||0) + 1;
    degree[b] = (degree[b]||0) + 1;
  });
  const top = tables
    .map(t => ({k: t.schema+"."+t.name, t}))
    .sort((a,b) => (degree[b.k]||0) - (degree[a.k]||0))
    .slice(0, 30);
  if (top.length === 0) return "";
  const W = 480, H = 320, cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 30;
  const pos = {};
  top.forEach((it, i) => {
    const a = (2 * Math.PI * i) / top.length - Math.PI/2;
    pos[it.k] = { x: cx + R*Math.cos(a), y: cy + R*Math.sin(a) };
  });
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:${H}px; background:rgba(255,255,255,0.02); border:1px solid var(--border); border-radius:4px">`;
  fks.forEach(fk => {
    const a = pos[fk.from_schema+"."+fk.from_table];
    const b = pos[fk.to_schema+"."+fk.to_table];
    if (a && b) {
      svg += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#5e6ad2" stroke-width="0.8" opacity="0.5" />`;
    }
  });
  top.forEach(it => {
    const p = pos[it.k];
    svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="#a371f7" />`;
    svg += `<text x="${p.x.toFixed(1)}" y="${(p.y-7).toFixed(1)}" text-anchor="middle" fill="#c9d1d9" font-size="9">${esc(it.t.name)}</text>`;
  });
  svg += `</svg>`;
  return svg;
}
```

### Step 6.5 — renderLogsDrawer + renderSaasDrawer

```js
function renderLogsDrawer(d) {
  if (!d) return `<div class="drawer-error">sin datos</div>`;
  const c = d.container || {};
  const stateClass = (c.state||"").toLowerCase() === "running" ? "ok" : "bad";
  const stateBadge = `<span class="health-pill health-pill-${stateClass}">${esc(c.state||"?")}</span>`;
  const health = d.health_status
    ? `<span class="health-pill health-pill-${d.health_status.startsWith("2")?"ok":"bad"}">HTTP ${esc(d.health_status)}</span>`
    : "";
  return `
    <section class="drawer-section">
      <h4>Container</h4>
      ${stateBadge} ${health}
      <table class="drawer-table">
        <tr><td>Nombre</td><td>${esc(c.name||"-")}</td></tr>
        <tr><td>Imagen</td><td>${esc(c.image||"-")}</td></tr>
        <tr><td>Status</td><td>${esc(c.status||"-")}</td></tr>
        ${d.health_url ? `<tr><td>Health URL</td><td><code>${esc(d.health_url)}</code></td></tr>` : ""}
      </table>
    </section>
    <section class="drawer-section">
      <h4>Logs (últimas ${d.logs_lines||0} líneas)</h4>
      <div class="drawer-logs">${esc(d.logs||"(sin logs)")}</div>
    </section>`;
}

function renderSaasDrawer(d) {
  return `
    <section class="drawer-section">
      <h4>SaaS</h4>
      <div class="muted">Este servicio es SaaS — no se monitoriza por SSH.</div>
      <pre class="drawer-logs">${esc(JSON.stringify(d.config || {}, null, 2))}</pre>
    </section>`;
}
```

### Checkpoint Task 6

- Refrescar navegador.
- Vista detalle: click en el centro (VPS) → drawer con sistema/discos/procesos/docker.
- Click en tile postgres real → drawer con Monitor + tab Schema con mini-grafo.
- Click en tile n8n real → drawer con workflows + ejecuciones.
- Click en tile chatwoot/backoffice → drawer con state badge + logs.

---

## Task 7 — Frontend: banner global de alertas + badge en cards

**Files:**
- Modify: `frontend/index.html` (slot banner)
- Modify: `frontend/map2d.js` (fetchActiveAlerts, renderAlertsBanner, badge en renderVpsCard)
- Modify: `frontend/map2d.css` (estilos banner + badge)

### Step 7.1 — index.html: banner slot

Justo dentro de `<body>`, antes de la barra principal, añadir:

```html
<div id="alerts-banner" class="hidden">
  <span class="ab-icon">⚠</span>
  <span class="ab-count">0</span>
  <span class="ab-text">alertas activas</span>
  <button id="alerts-banner-toggle" class="btn">Ver</button>
  <div id="alerts-banner-list" class="hidden"></div>
</div>
```

### Step 7.2 — map2d.js: fetch + render

Añadir:

```js
async function fetchActiveAlerts() {
  try {
    const r = await fetch("/api/alerts/active");
    if (!r.ok) return;
    const data = await r.json();
    activeAlerts = data.alerts || [];
    renderAlertsBanner();
  } catch (e) { /* ignore */ }
}

function renderAlertsBanner() {
  const banner = document.getElementById("alerts-banner");
  if (!banner) return;
  if (activeAlerts.length === 0) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  banner.querySelector(".ab-count").textContent = activeAlerts.length;
  const list = document.getElementById("alerts-banner-list");
  list.innerHTML = activeAlerts.map(a => `
    <div class="ab-item">
      <strong>${esc(a.client)}/${esc(a.project)}</strong>
      <span class="muted">${esc(a.service_name || a.service_id)}</span>
      <span class="health-pill health-pill-bad">${esc(a.kind)}</span>
      <span>${esc(a.reason || "")}</span>
    </div>`).join("");
  const toggle = document.getElementById("alerts-banner-toggle");
  if (toggle && !toggle._bound) {
    toggle._bound = true;
    toggle.onclick = () => list.classList.toggle("hidden");
  }
}
```

### Step 7.3 — Badge en cada vps-card

En `renderVpsCard`, calcular y añadir el badge:

```js
// Justo antes del return, calcular:
const alertCount = activeAlerts.filter(a =>
  a.service_id === vps.id || hostedServices.some(s => s.id === a.service_id)
).length;
const cardBadge = alertCount > 0
  ? `<span class="alert-badge">${alertCount}</span>` : "";

// En el header existente, justo después de <h3>${esc(vps.name)}</h3>, insertar:
//   ${cardBadge}
```

Modificar el template:

```js
return `
  <article class="vps-card vps-status-${health.status}${expanded ? " expanded" : ""}" data-vps-id="${esc(vps.id)}">
    <header class="vps-card-header">
      <span class="status-icon">${statusIcon}</span>
      <h3>${esc(vps.name)}</h3>
      ${cardBadge}
      <span class="expand-arrow">${expanded ? "▾" : "▸"}</span>
    </header>
    ...resto igual...`;
```

### Step 7.4 — Polling: incluir alertas en cada tick

Modificar `startPolling`:

```js
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await fetchAllHealth();
    await fetchActiveAlerts();
    if (viewMode === "detail") renderVpsDetailView();
    else renderGrid();
  }, 30000);
}
```

### Step 7.5 — CSS banner

Añadir a `map2d.css` (puede sobreescribir variables del `styles.css` si conviene; el banner es global):

```css
#alerts-banner {
  position: fixed;
  top: 0; left: 0; right: 0;
  background: rgba(239, 68, 68, 0.12);
  border-bottom: 1px solid #ef4444;
  padding: 6px 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  z-index: 200;
  color: #fecaca;
}
#alerts-banner.hidden { display: none; }
.ab-icon { font-size: 16px; }
.ab-count { font-weight: 700; }
#alerts-banner-list {
  position: absolute;
  top: 100%; left: 0; right: 0;
  background: var(--bg);
  border-bottom: 1px solid #ef4444;
  padding: 8px 16px;
  max-height: 240px;
  overflow-y: auto;
}
.ab-item {
  display: flex; gap: 10px; align-items: center;
  padding: 4px 0;
  border-bottom: 1px dashed var(--border);
  font-size: 12px;
}
```

### Checkpoint Task 7

- Crear regla `cpu_above: 0` para una VPS real vía curl (Task 4 checkpoint).
- Esperar ~30s. En el navegador debería aparecer banner arriba con count=1 y badge rojo en la card de esa VPS.
- Borrar la regla. Banner desaparece en el siguiente poll.

---

## Task 8 — Frontend: tab "Alertas" en cada proyecto

**Files:**
- Modify: `frontend/app.js` (añadir tab + view + handlers CRUD)
- Modify: `frontend/index.html` (markup del tab si hace falta)
- Modify: `frontend/styles.css` (estilos del formulario)

### Step 8.1 — Localizar tabs actuales en app.js

Buscar `projTabSet` y el contenedor de tabs por proyecto. Añadir un tab nuevo:

```js
const PROJ_TABS = ["map", "linear", "dev", "alerts"];
// O añadir "alerts" a la lista existente.
```

Y en el render de tabs (buscar el switch que renderiza el contenido por tab activo), añadir caso `"alerts"`.

### Step 8.2 — Render del tab Alertas

```js
async function renderAlertsTab(client, project) {
  const container = document.getElementById("proj-tab-content");
  container.innerHTML = `<div class="muted">Cargando alertas…</div>`;
  let data;
  try {
    const r = await fetch(`/api/projects/alerts?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`);
    data = await r.json();
  } catch (e) {
    container.innerHTML = `<div class="error">${e.message}</div>`;
    return;
  }
  const services = (currentProjectMeta()?.services) || [];
  const rules = data.rules || [];
  const state = data.state || {};
  container.innerHTML = `
    <div class="alerts-panel">
      <div class="alerts-header">
        <h3>Alertas (${rules.length})</h3>
        <button class="btn" id="alerts-new-btn">+ Nueva regla</button>
      </div>
      <table class="alerts-table">
        <thead><tr>
          <th>Etiqueta</th><th>Servicio</th><th>Tipo</th><th>Umbral</th>
          <th>Estado</th><th>Activa</th><th></th>
        </tr></thead>
        <tbody id="alerts-tbody">
          ${rules.map(r => renderAlertRow(r, services, state[r.id])).join("")}
        </tbody>
      </table>
      <div id="alert-form" class="hidden"></div>
    </div>`;
  document.getElementById("alerts-new-btn").onclick = () => showAlertForm(client, project, null, rules, services);
  rules.forEach(r => {
    const editBtn = document.getElementById(`alert-edit-${r.id}`);
    if (editBtn) editBtn.onclick = () => showAlertForm(client, project, r, rules, services);
    const delBtn = document.getElementById(`alert-del-${r.id}`);
    if (delBtn) delBtn.onclick = () => deleteAlert(client, project, r.id, rules);
    const enableBtn = document.getElementById(`alert-toggle-${r.id}`);
    if (enableBtn) enableBtn.onchange = () => toggleAlertEnabled(client, project, r.id, enableBtn.checked, rules);
  });
}

function renderAlertRow(r, services, st) {
  const svc = services.find(s => s.id === r.service_id);
  const svcLabel = svc ? `${svc.kind}/${svc.name}` : `<i>(${r.service_id} no encontrado)</i>`;
  const stPill = st && st.firing
    ? `<span class="health-pill health-pill-bad">firing</span> <span class="muted">${(r.reason||st.reason||"").substring(0,40)}</span>`
    : `<span class="muted">ok</span>`;
  return `<tr>
    <td>${esc(r.label || "-")}</td>
    <td>${svcLabel}</td>
    <td><code>${esc(r.kind)}</code></td>
    <td>${r.threshold == null ? "-" : r.threshold}</td>
    <td>${stPill}</td>
    <td><input type="checkbox" id="alert-toggle-${r.id}" ${r.enabled ? "checked" : ""}/></td>
    <td>
      <button class="btn-link" id="alert-edit-${r.id}">editar</button> ·
      <button class="btn-link" id="alert-del-${r.id}">borrar</button>
    </td>
  </tr>`;
}

function showAlertForm(client, project, rule, rules, services) {
  const form = document.getElementById("alert-form");
  form.classList.remove("hidden");
  const r = rule || { id: "", service_id: services[0]?.id || "", kind: "cpu_above",
                      threshold: 80, enabled: true, label: "" };
  form.innerHTML = `
    <h4>${rule ? "Editar regla" : "Nueva regla"}</h4>
    <label>Etiqueta <input id="af-label" value="${esc(r.label||"")}" /></label>
    <label>Servicio
      <select id="af-service">
        ${services.map(s => `<option value="${esc(s.id)}" ${s.id===r.service_id?"selected":""}>${esc(s.kind)} · ${esc(s.name)}</option>`).join("")}
      </select>
    </label>
    <label>Tipo
      <select id="af-kind">
        ${["cpu_above","ram_above","disk_above","container_down","n8n_workflow_failed","health_url_not_2xx"]
          .map(k => `<option value="${k}" ${k===r.kind?"selected":""}>${k}</option>`).join("")}
      </select>
    </label>
    <label>Umbral <input id="af-threshold" type="number" min="0" max="100" value="${r.threshold ?? ""}" /></label>
    <label><input id="af-enabled" type="checkbox" ${r.enabled?"checked":""}/> Activa</label>
    <div>
      <button class="btn" id="af-save">Guardar</button>
      <button class="btn" id="af-cancel">Cancelar</button>
    </div>`;
  document.getElementById("af-cancel").onclick = () => { form.classList.add("hidden"); };
  document.getElementById("af-save").onclick = async () => {
    const updated = {
      id: r.id || "",
      service_id: document.getElementById("af-service").value,
      kind: document.getElementById("af-kind").value,
      threshold: parseFloat(document.getElementById("af-threshold").value) || null,
      enabled: document.getElementById("af-enabled").checked,
      label: document.getElementById("af-label").value,
    };
    const next = rule
      ? rules.map(x => x.id === rule.id ? updated : x)
      : [...rules, updated];
    await saveAlerts(client, project, next);
  };
}

async function saveAlerts(client, project, rules) {
  const r = await fetch(`/api/projects/alerts?client=${encodeURIComponent(client)}&project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({rules})
  });
  if (!r.ok) {
    const e = await r.json().catch(()=>({error:"error"}));
    alert("Error: " + (e.error || r.status));
    return;
  }
  renderAlertsTab(client, project);
}

async function deleteAlert(client, project, id, rules) {
  if (!confirm("¿Borrar esta regla?")) return;
  await saveAlerts(client, project, rules.filter(r => r.id !== id));
}

async function toggleAlertEnabled(client, project, id, enabled, rules) {
  const next = rules.map(r => r.id === id ? {...r, enabled} : r);
  await saveAlerts(client, project, next);
}
```

### Step 8.3 — Helper `currentProjectMeta()`

Si no existe ya, exponer una forma de obtener el meta del proyecto actualmente abierto. Buscar la variable global del meta (probablemente `currentMeta` o similar) y crear un wrapper:

```js
function currentProjectMeta() {
  // Reusar la variable global donde app.js ya guarda el meta del proyecto abierto
  return window.__currentMeta || null;
}
```

(Ajustar al nombre real que use app.js — el plan ejecutor lo verificará al implementar).

### Step 8.4 — Añadir entrada al menú de tabs

Buscar en `index.html` (o donde se generen los botones de tabs por proyecto) y añadir botón `Alertas` que llame a `projTabSet("alerts")`.

### Step 8.5 — Estilos

Añadir a `styles.css`:

```css
.alerts-panel { padding: 12px; }
.alerts-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; }
.alerts-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.alerts-table th, .alerts-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; }
.alerts-table th { font-weight: 500; color: var(--muted); font-size: 11px; }
#alert-form {
  margin-top: 16px; padding: 12px;
  background: var(--tool); border: 1px solid var(--border); border-radius: 6px;
}
#alert-form label { display:block; margin: 8px 0; }
#alert-form input, #alert-form select { width: 100%; padding: 4px 6px; }
.btn-link { background: transparent; border: 0; color: var(--accent, #58a6ff); cursor: pointer; padding: 0; }
```

### Checkpoint Task 8

- Refrescar navegador. En un proyecto con VPS real, ir al tab "Alertas".
- Crear una regla `cpu_above: 0` desde el formulario.
- Esperar 30s. Banner global aparece, badge en la card del mapa también.
- Editar la regla → cambiar a `cpu_above: 99` → banner desaparece en el siguiente poll.
- Borrar la regla → desaparece de la tabla.

---

## Task 9 — Verificación end-to-end + commit final

### Step 9.1 — Smoke test full

1. `python3 backend/server.py` corre sin tracebacks.
2. Navegador en `http://127.0.0.1:8788` → login OK.
3. Click en una VPS real → vista detalle aparece con tiles.
4. Click en el VPS centro → drawer con sistema/docker.
5. Click en tile postgres (si existe) → drawer Monitor/Schema con datos reales.
6. Click en tile n8n (si existe) → drawer con workflows.
7. Click en tile chatwoot/backoffice → drawer con logs.
8. Tab Alertas en un proyecto → crear regla cpu_above:0 → banner aparece.
9. Borrar regla → banner desaparece.
10. Recargar página → todo persiste excepto el estado in-memory de las alertas (que se reconstruye al primer poll).

### Step 9.2 — Commit único

```bash
git add backend/server.py frontend/map2d.js frontend/map2d.css frontend/index.html frontend/app.js frontend/styles.css .gitignore
git commit -m "$(cat <<'EOF'
feat(fase8): drill-in por VPS + detalle real por servicio + alertas en panel

Backend:
- Schema v4→v5 (config.role/container/health_url, backwards compat)
- Probes por kind reusando ssh_run: vps, n8n (workflows+executions),
  postgres (stats+schema con FKs), containers (logs+inspect+health_url)
- DETAIL_CACHE con TTL 15s para evitar SSHs repetidos
- GET /api/services/detail?client&project&service
- .alerts.json por proyecto (perm 600, en .gitignore)
- Evaluador en health_poll_loop: cpu/ram/disk/container_down/
  n8n_workflow_failed/health_url_not_2xx
- GET/POST /api/projects/alerts + GET /api/alerts/active

Frontend:
- Vista detalle full-page: VPS centro + tiles de servicios alrededor
- Drawer lateral con renderer por kind (n8n tabla workflows,
  postgres tabs Monitor/Schema con mini-grafo FK, containers con logs)
- Banner global de alertas firing + badge por card
- Tab "Alertas" por proyecto: CRUD de reglas
EOF
)"
```

### Step 9.3 — Verificar branch state

```bash
git log --oneline -5
git status   # → clean
```

---

## Self-review checklist (antes de ejecutar)

- [x] Spec coverage: probes (vps/n8n/postgres/chatwoot/backoffice/saas) ✓, alertas (6 kinds) ✓, banner ✓, badge ✓, tab ✓.
- [x] Sin placeholders: todos los snippets contienen código real.
- [x] Consistencia de tipos: `service_id`, `client`, `project` siempre strings; `metrics.cpu_pct/ram_pct/disk_pct_max` consistente con F6.
- [x] Único commit al final (Task 9).
- [x] Sin tests automatizados (manual checklists).
- [x] Stdlib only (sin imports nuevos: ya usamos `subprocess`, `json`, `threading`, `time`, `base64`, `os` en el server).
