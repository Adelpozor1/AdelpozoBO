# Fase 8 — Detalle por servicio + alertas por proyecto (design)

**Fecha:** 2026-06-30
**Branch:** `main`
**Estado:** Aprobado

## Contexto

Tras F7 cada VPS aparece como una tarjeta con mini-mapa SVG (VPS centro + carreteras radiales a servicios alojados + satélites). El usuario puede ver el estado (ok/warn/down) y métricas básicas (CPU/RAM/Disk), pero **no puede entrar en cada servicio para inspeccionarlo en directo**.

Lo que falta es:

1. **Drill-in interactivo por VPS**: click en una VPS → vista grande con el VPS en el centro y los servicios alrededor; click en un servicio → panel de detalle.
2. **Detalle específico por kind**:
   - **vps** → métricas del SO + top procesos + overview Docker.
   - **n8n** → lista de workflows + ejecuciones recientes + health del contenedor.
   - **postgres** → mapa conceptual del esquema (tablas / FK) + monitorización (tamaño / conexiones / version).
   - **chatwoot** → estado del contenedor + logs.
   - **backoffice** (docker con `role=backoffice`) → estado del contenedor + logs + check de health endpoint.
3. **Alertas por proyecto**: reglas configurables (CPU > X, RAM > X, container down, …) evaluadas en cada poll. Cuando una regla salta aparece banner global + badge en la tarjeta del proyecto.

Todo el monitor es **real por SSH** (decisión F6, mantenida). No se introducen dependencias nuevas en el backend (stdlib only).

## Restricciones

- **Backend stdlib only**: nada de psycopg2/requests/etc. Todo lo que necesitemos de Postgres se hace vía `docker exec ... psql -tAF '|' -c '<SELECT>'`; lo de containers vía `docker ps/inspect/logs`; lo de n8n vía la propia base (que ya tenemos parseada en F6).
- **Sin tests automatizados**: el repo no tiene framework; verificación manual con `curl` + browser.
- **Un único commit al final** del plan de ejecución (política del usuario).
- **Schema bump**: meta pasa de v4 a v5 (añadimos campos opcionales en service.config — backwards compatible: los meta v4 se siguen leyendo sin migración).
- **Mantener el mapa 2D existente** (F7): la nueva vista es una segunda pantalla a la que se entra haciendo click en una card; el grid de cards no desaparece.

## Modelo de datos

### Schema bump v4 → v5

Tres campos opcionales nuevos en `service.config`, todos para servicios alojados en una VPS:

```jsonc
{
  "id": "svc-postgres-1",
  "kind": "postgres",
  "name": "Postgres prod",
  "config": {
    "on_host": "vps-1",
    // NUEVO (todos opcionales):
    "role": "db" | "backoffice" | "n8n" | "chatwoot" | "app" | "other",
    "container": "postgres",           // prefijo o nombre exacto del contenedor docker
    "health_url": "http://localhost:3000/health"   // sólo para backoffice/app: HTTP GET por SSH
  }
}
```

- `role` es libre y se usa para elegir renderer y para reglas de alerta ("container_down" mira role=…).
- `container` permite distinguir varios contenedores del mismo kind en una VPS (p. ej. dos backoffices: bo-testing, bo-stg).
- `health_url`: cuando exista, el probe hace `curl -s -m 3 -o /dev/null -w '%{http_code}' <url>` por SSH.

`validate_meta_payload` añade reglas:
- `config.role` debe ser uno de los enum si está presente; si no, se omite.
- `config.container` y `config.health_url` strings, longitud ≤ 200.

Los meta v4 (sin esos campos) se siguen leyendo y se asume `role=kind`, `container=kind`, `health_url` ausente.

### Alertas: archivo nuevo por proyecto

Junto a `.panel.json` y `.linear.token` vive `.alerts.json` (permisos 600, en `.gitignore`):

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "alr-001",
      "service_id": "vps-1",           // referencia a service.id
      "kind": "cpu_above",             // ver enum más abajo
      "threshold": 80,                 // según kind
      "enabled": true,
      "label": "CPU alto en VPS prod"  // opcional, mostrado en UI
    }
  ]
}
```

Enum de `kind`:

| kind                       | aplica a              | threshold      | dispara cuando                              |
|----------------------------|-----------------------|----------------|---------------------------------------------|
| `cpu_above`                | vps                   | 0..100 (%)     | metrics.cpu_pct > threshold                 |
| `ram_above`                | vps                   | 0..100 (%)     | metrics.ram_pct > threshold                 |
| `disk_above`               | vps                   | 0..100 (%)     | metrics.disk_pct_max > threshold            |
| `container_down`           | service con container | —              | container no aparece en `docker ps` running |
| `n8n_workflow_failed`      | service kind=n8n      | —              | última ejecución del workflow status=error  |
| `health_url_not_2xx`       | service con health_url| —              | curl devuelve != 2xx                        |

Estado de alertas (transitorio, en memoria — no persistido):

```python
ALERT_STATE = {
  "<rule_id>": {"firing": True, "since": 1719791234.5, "last_check": 1719791264.5, "reason": "CPU 92%"}
}
```

Se rellena al final de cada `health_poll_loop` (mismo daemon que F6). El estado se sirve combinado con las reglas en `GET /api/projects/alerts`.

## Backend

### Endpoint nuevo: `GET /api/services/detail`

```
GET /api/services/detail?client=X&project=Y&service=Z
```

Devuelve detalle en vivo del servicio identificado por `service` (id del service). El backend:

1. Carga `meta` del proyecto, busca el service por id.
2. Encuentra la VPS host: si `service.kind == "vps"` es él mismo; si no, busca el service con `id == service.config.on_host`.
3. Cachea por `service_id` con TTL configurable (default 15s) → `DETAIL_CACHE`. Si hay entrada fresca, la devuelve sin SSH.
4. Si no, despacha al probe correspondiente:

| service kind                    | probe                                  | resultado                            |
|---------------------------------|----------------------------------------|--------------------------------------|
| `vps`                           | `probe_vps(host)` → reusa `parse_report` | `{system, docker, n8n, db}`        |
| `n8n`                           | `probe_n8n(host, container)`           | `{health, workflows, recent}`        |
| `postgres`                      | `probe_postgres(host, container, db)`  | `{stats, schema}`                    |
| `chatwoot`                      | `probe_container_logs(host, container)`| `{container, logs, health_url?}`     |
| `docker` (role=backoffice/app)  | `probe_container_logs(host, container)`| `{container, logs, health_url?}`     |
| `github` / `linear` (satélite)  | sin probe — devuelve `{kind: "saas"}`  | UI muestra link al panel SaaS         |

Respuesta:

```jsonc
{
  "service": { "id": "...", "kind": "...", "name": "..." },
  "host_vps": { "id": "...", "name": "..." },
  "ts": 1719791234.5,
  "data": { /* específico por kind */ },
  "error": null | "mensaje breve"
}
```

5. Cachea el resultado y responde 200.

#### Probes (todos vía `ssh_run`)

**`probe_vps(host)`**: ya existe — ejecuta `build_collector(host)` y devuelve `parse_report(raw, host)`. Mismo camino que `/api/monitor/report`.

**`probe_n8n(host, container)`**: ejecuta un script bash:

```bash
docker exec <container> wget -q -S -O /dev/null http://localhost:5678/healthz 2>&1 | head -1
docker exec <DB_CONTAINER> psql -U postgres -d n8n -tAF '|' -c "SELECT id, name, active::text FROM workflow_entity ORDER BY \"updatedAt\" DESC LIMIT 50"
docker exec <DB_CONTAINER> psql -U postgres -d n8n -tAF '|' -c "SELECT id, \"workflowId\", status::text, to_char(\"startedAt\",'YYYY-MM-DD HH24:MI'), mode FROM execution_entity ORDER BY \"startedAt\" DESC LIMIT 30"
```

Devuelve `{health: "200"|other, workflows: [...], recent: [...]}`. El DB de n8n se busca asumiendo que es el postgres declarado en el mismo proyecto con `role=db` (o `kind=postgres`) — fallback: postgres del mismo container_name que F6 ya usaba.

**`probe_postgres(host, container, db_user, db_name)`**: dos bloques en un sólo SSH:

```bash
# Bloque 1: stats
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT pg_size_pretty(pg_database_size(current_database()))"
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT count(*) FROM pg_stat_activity"
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SHOW server_version"
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT pid, state, query_start::text, substr(query,1,80) FROM pg_stat_activity WHERE state != 'idle' AND pid != pg_backend_pid() ORDER BY query_start LIMIT 10"

# Bloque 2: schema
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2"
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,ordinal_position"
docker exec <c> psql -U <u> -d <d> -tAF '|' -c "SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_schema, ccu.table_name, ccu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type='FOREIGN KEY'"
```

Devuelve:

```jsonc
{
  "stats": { "size": "1.2 GB", "conns": 12, "version": "16.2", "active_queries": [...] },
  "schema": {
    "tables": [
      { "schema": "public", "name": "users", "columns": [{"name":"id","type":"uuid","nullable":false},...] },
      ...
    ],
    "fks": [
      { "from_schema":"public", "from_table":"orders", "from_column":"user_id",
        "to_schema":"public", "to_table":"users", "to_column":"id" },
      ...
    ]
  }
}
```

Para evitar reports gigantes en bases grandes: cap a 200 tablas y 2000 columnas; si se trunca, `schema.truncated: true`.

**`probe_container_logs(host, container, health_url=None)`**:

```bash
docker ps --format '{{json .}}' --filter "name=^<container>(\.|$)"
docker inspect --format '{{json .State}}' <resolved_container>
docker logs --tail 200 --timestamps <resolved_container> 2>&1
# si health_url:
curl -s -m 3 -o /dev/null -w '%{http_code}' <health_url>
```

Devuelve:

```jsonc
{
  "container": { "name":"bo-testing", "image":"...", "state":"running", "status":"Up 3 days", "started":"2026-06-25T..." },
  "logs": "2026-06-30T18:00:01Z [INFO] ...\n2026-06-30T...",
  "logs_truncated": false,
  "health_url": "http://localhost:3000/health",
  "health_status": "200"
}
```

Cap de logs: las últimas 200 líneas (suficiente para el panel; si quieres más, abre el detalle de nuevo o redirige al usuario a SSH).

### Evaluador de alertas en `health_poll_loop`

Tras actualizar `HEALTH_CACHE`, en el mismo loop se evalúan reglas:

```python
def evaluate_alerts():
    for client_dir, proj_dir in iter_projects():
        rules = load_alerts(client, project)  # lista de reglas
        meta = load_project_meta(client, project)
        for rule in rules:
            if not rule.get("enabled", True): continue
            service = find_service(meta, rule["service_id"])
            if not service: continue
            fired, reason = evaluate_rule(rule, service, meta)
            key = rule["id"]
            prev = ALERT_STATE.get(key)
            if fired and not (prev and prev.get("firing")):
                ALERT_STATE[key] = {"firing": True, "since": time.time(), "last_check": time.time(),
                                     "reason": reason, "service_id": rule["service_id"],
                                     "client": client, "project": project, "rule_label": rule.get("label")}
            elif fired:
                ALERT_STATE[key]["last_check"] = time.time()
                ALERT_STATE[key]["reason"] = reason
            elif prev and prev.get("firing"):
                ALERT_STATE[key]["firing"] = False
                ALERT_STATE[key]["last_check"] = time.time()
```

`evaluate_rule(rule, service, meta)` decide:

- `cpu_above` / `ram_above` / `disk_above`: lee `HEALTH_CACHE[service.id].metrics.*` (service debe ser kind=vps).
- `container_down`: busca el container declarado en `service.config.container` dentro del último `parse_report` cacheado de la VPS host (o, si la VPS está down, dispara la regla).
- `n8n_workflow_failed`: igual, mira el último parsed n8n.recent y si la última ejecución (más reciente) tiene status=error.
- `health_url_not_2xx`: requiere un probe extra → se lanza por SSH al evaluar (mismo intervalo del poll).

Para evitar duplicar SSHs, **`container_down` y `n8n_workflow_failed` reutilizan el `HEALTH_CACHE` que F6 ya rellena**; sólo `health_url_not_2xx` añade SSH adicional.

### Endpoints nuevos de alertas

```
GET  /api/projects/alerts?client&project
     → { "rules": [...], "state": { "<rule_id>": { "firing": true, "since": ..., "reason": "..." } } }

POST /api/projects/alerts?client&project
     body: { "rules": [...] }
     → { "ok": true }
```

`GET /api/alerts/active` (global, sin client/project): devuelve **todas** las alertas firing en cualquier proyecto. La usa el banner global del frontend para no recorrer todos los proyectos.

## Frontend

### Cambio de vista: grid → detalle

`map2d.js` añade un segundo modo de render — además de `renderGrid()` actual, una nueva función `renderVpsDetailView(vpsItem)`. El estado pasa a tener:

```js
let viewMode = "grid"     // "grid" | "detail"
let detailVpsId = null    // id del VPS en detalle
let detailServiceId = null  // si hay drawer abierto
```

Click en el cuerpo de una tarjeta VPS (no en el header expand) → `enterDetail(vpsId)` → `viewMode="detail"` → render.

### Layout de la vista detalle

Pantalla completa dentro de `#map-home` (oculta el grid mientras esté en detail):

```
+---------------------------------------------------------------+
| ← Volver al mapa     VPS: Hostinger DiveAcademy   🟢 Operativa |
+---------------------------------------------------------------+
|                                                                |
|              [tile postgres]   [tile n8n]                      |
|                       ╲           ╱                            |
|                    ┌───────────────┐                           |
|                    │   VPS centro  │  ← métricas resumen        |
|                    │   CPU 12% ... │                           |
|                    └───────────────┘                           |
|                       ╱           ╲                            |
|              [tile chatwoot]   [tile backoffice]               |
|                                                                |
+---------------------------------------------------------------+
|                              [drawer si hay servicio abierto]  |
+---------------------------------------------------------------+
```

- El VPS centro: un panel grande clickable con CPU/RAM/Disk + uptime + iconos de avería (🟢/⚠️/⛔). Al hacer click → abre drawer con `probe_vps` completo (top procesos, mem, disco por filesystem, docker overview).
- Los tiles alrededor: uno por cada service alojado (config.on_host==vps.id). Cada tile muestra `kind + name + estado` derivado del cache (o "—" si no probado aún). Click → fetch a `/api/services/detail` y abre drawer con el renderer correspondiente.
- Los satélites SaaS (github/linear) se ven como tiles pequeños en una segunda fila inferior con etiqueta "satélites".
- Al lado del header: badge si hay alertas firing para algún service de esta VPS.

### Drawer lateral

`<aside id="svc-drawer" class="hidden">` con header (kind icon + name + ✕) y body. Cuando se abre:

1. Marca como loading.
2. Llama `GET /api/services/detail?...`.
3. Pasa la respuesta al renderer del kind:
   - `renderVpsDrawer(data)`: tabla de procesos, gráfico ASCII de disco por mount, lista de containers con state/cpu/mem.
   - `renderN8nDrawer(data)`: badge de health, tabla de workflows (id, nombre, active), tabla de ejecuciones recientes (status badge).
   - `renderPostgresDrawer(data)`: dos pestañas dentro del drawer — **Monitor** (size/conns/version + lista de queries activas) y **Schema** (lista expandible de tablas + mini-grafo SVG de FKs).
   - `renderChatwootDrawer(data)`: estado del container + pre con últimos 200 logs (scroll, monospace).
   - `renderBackofficeDrawer(data)`: igual que chatwoot + health badge si hay url.

El mini-grafo de FKs en postgres es un SVG simple: layout circular de tablas (cap a 30 tablas más conectadas), líneas curvas conectando FKs. Si hay más de 30 tablas, mostrar la lista textual y un toggle "Ver grafo (cap 30)".

### Banner global de alertas

En `index.html` añadir un slot fijo arriba (debajo de la barra principal):

```html
<div id="alerts-banner" class="hidden">
  <span class="alerts-banner-count">0</span>
  <span class="alerts-banner-text">alertas activas</span>
  <button id="alerts-banner-open">Ver</button>
</div>
```

Al cargar (y cada 30s vía el polling del map2d) se llama `GET /api/alerts/active`:

- Si hay > 0: banner visible con count + lista resumida al click ("Ver" abre un dropdown con cliente/proyecto/regla y un link "ir al proyecto").
- Si hay 0: banner oculto.

Adicionalmente, cada `vps-card` en el grid muestra un `badge` rojo con el número de alertas firing para los services de esa VPS.

### Tab "Alertas" por proyecto

En la vista de proyecto (la del formulario F1, gestionada por `app.js`) se añade un tab nuevo "Alertas" junto a los existentes (Mapa, Linear, ...).

Layout de la tab:

- Lista de reglas existentes (tabla: label, service, kind, threshold, enabled toggle, eliminar).
- Botón "+ Nueva regla" → modal con form:
  - `service` (select de services del proyecto, con kind y nombre)
  - `kind` (select del enum)
  - `threshold` (input number, sólo si el kind lo requiere)
  - `label` (input text, opcional)
- Al guardar → `POST /api/projects/alerts` con la lista completa actualizada.

## Flujo de datos completo

```
[Browser] 
  ↳ click en VPS card body
      → mapData ya en memoria
      → renderVpsDetailView(vpsItem)
  ↳ click en tile (servicio)
      → fetch /api/services/detail?...
          → backend busca service en meta
          → resuelve host VPS
          → check DETAIL_CACHE[service.id]
          → si miss: probe_<kind>(host, ...) por SSH
          → guarda cache (TTL 15s)
          → responde JSON
      → renderXXXDrawer(data)
  ↳ banner cada 30s
      → fetch /api/alerts/active
          → lee ALERT_STATE (lo rellena health_poll_loop)
          → responde lista de firing
      → si > 0 muestra banner
```

## Compatibilidad y migración

- Schema v4 → v5 backwards compatible: meta sin los nuevos campos sigue funcionando (renderer hosted_service usa `kind` como `role` por defecto).
- `.alerts.json` opcional: si no existe → `rules: []`. No se crea hasta el primer `POST`.
- Endpoints nuevos no rompen los existentes (`/api/world`, `/api/projects/health`, `/api/monitor/report` siguen idénticos).
- Frontend: el botón nuevo de entrada al detalle es ADICIONAL al expand actual; el comportamiento existente (click en header → expand inline) se mantiene.

## Verificación manual (al final)

1. `python3 backend/server.py` arranca sin errores.
2. `curl -s 'http://127.0.0.1:8788/api/services/detail?client=X&project=Y&service=vps-1' --cookie ...` devuelve JSON con `data.system`.
3. Mismo curl para un service kind=postgres devuelve `data.schema.tables`.
4. Mismo curl para un service con container devuelve `data.logs`.
5. `curl -s 'http://127.0.0.1:8788/api/alerts/active'` devuelve `[]` cuando no hay reglas.
6. Crear una regla "cpu_above: 0" → al siguiente poll → banner aparece + badge en la card.
7. En el navegador: click en card de VPS real → detalle se carga, tiles aparecen, click en tile postgres → drawer con tablas + FKs.
8. Borrar la regla → banner desaparece tras el siguiente poll.

## Out of scope

- Persistencia histórica de métricas (no hay base de datos local, no se guarda series temporales).
- Notificaciones externas (Telegram / email / Slack) — decidido por el usuario: solo panel.
- Edición de schema desde el panel (sólo lectura).
- Logs anteriores a las últimas 200 líneas (para más → usar SSH directamente).
- Editor de workflows n8n (sólo lectura del estado).
- Métricas por contenedor más allá de las que `docker stats --no-stream` ya da.

## Riesgos

- **SSH lento o caído**: el polling es cada 30s con timeout 15s. El detail tiene TTL 15s → al primer click puede tardar hasta ~15s (estamos en la VPS real). Mitigación: loading state en el drawer + reusar último `HEALTH_CACHE` si el probe falla.
- **Postgres muy grande**: schema con miles de tablas → cap a 200 + flag `truncated`.
- **Containers con nombres dinámicos** (Docker Swarm): se reusa `resolve_container` ya existente que acepta prefijos.
- **Permisos SSH**: si el user SSH no es root, `docker exec` puede fallar. Documentar en `panel.conf.example` que la clave debe pertenecer a un user con acceso a docker (en el grupo docker o sudo NOPASSWD para docker).

## Decisión final del usuario (registrada para no re-preguntar)

- **Fuente de datos**: Todo por SSH (no APIs directas).
- **Backoffices**: Contenedores Docker en la misma VPS.
- **Alertas**: Solo panel (banner + badge), sin email/Telegram.
