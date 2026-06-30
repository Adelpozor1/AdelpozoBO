# Proyectos + Mapa de plataforma — Fase 1 (cimientos)

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

El panel actual tiene una pestaña "Desarrollo" en el header donde el usuario navega Cliente → Proyecto → Repos, una pestaña "Monitorización" para una VPS externa y una pestaña "Linear" que muestra todas las issues del workspace con un único token global (`backend/linear.token`).

La visión a largo plazo es convertir el panel en un **mapa 3D navegable** que actúe como home: un mapa grande donde cada **ciudad** representa un Proyecto del usuario, cada **zona** dentro de la ciudad es un servicio que compone ese proyecto (VPS, n8n, Docker, Chatwoot, Postgres, etc.) y los **cables** entre zonas representan las conexiones entre servicios. Click en una zona → ves su monitorización en vivo.

Esa visión es trabajo de semanas y se ha decidido trocearla en tres specs encadenados:

- **Fase 1 (este documento)** — cimientos: rename de la pestaña, metadata por proyecto en disco, token Linear por proyecto, captura de servicios y conexiones vía formulario plano. **Sin 3D, sin nueva ingesta de monitor.**
- **Fase 2** — ingesta de monitorización por tipo de zona (Chatwoot, Docker standalone, etc.) reusando la actual infraestructura de Monitorización.
- **Fase 3** — mapa 3D como home (Three.js u otra librería WebGL por CDN), leyendo la metadata escrita en Fase 1.

Esta Fase 1 es la base de datos sobre la que se monta todo lo demás. Sin esta capa, no hay nada que pintar, monitorizar ni consultar.

## Decisiones tomadas durante el brainstorming

1. **Linear por proyecto = workspace dedicado**: cada Proyecto del panel tiene su propio token de Linear que da acceso a un workspace dedicado. No hay que filtrar por team/project/label dentro de ese workspace — todo lo que ve el token ya es del proyecto. El token global (`backend/linear.token`) se mantiene como fallback.
2. **Editor en Fase 1 = formulario plano**, no canvas, no drag&drop, no 3D. La complejidad visual llega en Fase 3.
3. **Modelo de datos**: dos archivos nuevos por proyecto, separando config no-secreta del secreto.
4. **API**: full-replace para metadata, endpoint dedicado para el token. Endpoints granulares se descartan para Fase 1 por simplicidad.
5. **Pestaña Linear del header**: se contextualiza al proyecto activo (cuando hay uno). Cuando no hay proyecto activo, sigue mostrando el global.
6. **Sin tests automatizados en Fase 1**: el proyecto no tiene framework de tests; verificación manual con checklist. Introducir tests se difiere a Fase 2.

## Sección 1 — UX y alcance

### Rename

- `frontend/index.html:25`: `<button id="tabDev" class="tab active">Desarrollo</button>` → `<button id="tabDev" class="tab active">Proyectos</button>`.
- `frontend/styles.css:113`: comentario `/* pestañas de sección (Desarrollo / Monitorización) */` → `/* pestañas de sección (Proyectos / Monitorización) */`.
- Identificadores internos (`#tabDev`, `showDev()`, `setSection("dev")`) **no se renombran**. No afectan al usuario y renombrarlos en cadena añade ruido sin valor.

### Nueva sub-pestaña "Mapa" dentro de un Proyecto

Hoy, cuando entras a un Proyecto, ves la sidebar de repos + el chat. Añadir una barra de pestañas dentro del workspace del proyecto:

```
Cliente / Proyecto         [Repos] [Mapa]
─────────────────────────────────────────
   sidebar repos | conversaciones + chat   (vista actual, sin cambios)
   editor formulario (cuando "Mapa" activo)
```

- Implementación: envolver el contenido actual del `#main-row` en un `<div id="repos-area">` y añadir un sibling `<div id="map-area" class="hidden">`. Un `<div class="proj-tabs">` con dos botones alterna `.hidden` entre los dos.
- Default: "Repos" activo. Los flujos existentes no cambian.

### Pestaña Linear del header — comportamiento contextual

- Si hay un Proyecto activo (estado interno `currentProject = {client, project}`):
  - Llama a `GET /api/projects/linear/issues?client=&project=` y `/all` en lugar de los endpoints globales `/api/linear/issues` y `/api/linear/all`.
  - El backend resuelve el token: primero busca `.linear.token` del proyecto; si no existe, usa el global; si no hay ninguno, devuelve 400 legible.
  - La cabecera de la vista Linear indica "Linear de Cliente / Proyecto" o "Linear de Cliente / Proyecto · usando token global (fallback)" según corresponda.
- Si NO hay Proyecto activo (vistas Clientes o Proyectos):
  - Sigue llamando a `/api/linear/issues` y `/api/linear/all` exactamente como hoy. Sin cambio para el usuario.

## Sección 2 — Modelo de datos

Dos archivos nuevos por proyecto en `projects_dir/<cliente>/<proyecto>/`:

### `.panel.json` — config no-secreta

Permisos `600`. **No** se devuelve nunca el contenido del `.linear.token` aunque vivan en la misma carpeta.

```json
{
  "version": 1,
  "services": [
    {
      "id": "vps-7f2a",
      "kind": "vps",
      "name": "VPS principal",
      "config": { "host": "1.2.3.4", "user": "ubuntu", "port": 22 }
    },
    {
      "id": "n8n-9b41",
      "kind": "n8n",
      "name": "n8n cliente X",
      "config": { "on_host": "vps-7f2a", "container": "n8n_prod" }
    }
  ],
  "connections": [
    { "id": "c-1a", "from": "n8n-9b41", "to": "vps-7f2a", "label": "host" }
  ]
}
```

**Reglas:**

- `id` lo genera el backend con `secrets.token_hex(2)` y el prefijo del `kind` (o `c-` para conexiones). El frontend nunca inventa ids.
- `kind` enum cerrado en Fase 1: `vps | n8n | docker | chatwoot | postgres | github | linear | custom`. Ampliable sin migración (se añade al enum y ya).
- `name`: string no vacío, ≤ 100 caracteres.
- `config`: objeto JSON o `null`. **No** se valida el contenido interno en Fase 1 — cada `kind` recomienda unos campos pero el backend acepta cualquier objeto. Razón: añadir un nuevo `kind` no debería requerir tocar 3 capas; la validación estricta llega en Fase 2 cuando cada tipo gane su integración de monitor.
- `connections.from` y `connections.to`: ids de servicios presentes en el mismo payload tras la asignación de ids. Si no existen → 400.
- `label`: string libre opcional. Texto corto.
- Sin campo `kind` en conexión. Si más adelante hace falta tipar cables, se añade sin romper schema.
- Caps: ≤ 100 servicios y ≤ 500 conexiones por proyecto.

### `.linear.token` — token de Linear del proyecto

Permisos `600`. Una sola línea con el token (`lin_api_…`). Mismo patrón que el `backend/linear.token` global actual (`save_linear_token` en `server.py:176`).

### Compatibilidad

- Proyectos existentes que no tienen `.panel.json` arrancan con metadata vacía (`services: [], connections: []`). El backend devuelve esa respuesta sin error cuando el archivo no existe.
- El `backend/linear.token` global sigue funcionando como hoy. Ver Sección 5 para política de fallback.

## Sección 3 — Endpoints backend

Estilo: GET con query string para lectura, POST con JSON para escritura. Auth: cookie de sesión existente. Concurrencia: reuso del lock por proyecto que ya existe en `server.py` para serializar lecturas/escrituras de `.panel.json` y `.linear.token`.

| Método | Ruta | Body / Query | Respuesta |
|---|---|---|---|
| GET | `/api/projects/meta?client=&project=` | — | `{services, connections, linear_status: {has_project_token, has_global_fallback}}` |
| POST | `/api/projects/meta` | `{client, project, services, connections}` | Objeto guardado con ids asignados a servicios/conexiones nuevos |
| POST | `/api/projects/linear-token` | `{client, project, token}` | `{ok: true}` — el token nunca se devuelve |
| GET | `/api/projects/linear/issues?client=&project=` | — | Mismo shape que `/api/linear/issues` actual |
| GET | `/api/projects/linear/all?client=&project=` | — | Mismo shape que `/api/linear/all` actual |

### Validación

- `client` y `project` pasan por `valid_name()` (`server.py:280`) y `safe_join()` (`server.py:284`).
- `services[*].kind` ∈ enum. Si no → 400.
- `services[*].name`: string no vacío, ≤ 100 chars.
- `services[*].config`: objeto JSON o null.
- `connections[*].from/to`: ids de servicios presentes en el mismo payload tras asignación.
- Caps: ≤ 100 servicios, ≤ 500 conexiones por payload.

### Asignación de ids

- Si llega un servicio sin `id`, el backend asigna `{kind}-{secrets.token_hex(2)}` (p. ej. `vps-7f2a`). Para `kind=custom`, se usa el literal `custom-XXXX`.
- Si llega con `id`, el backend lo respeta pero rechaza colisiones dentro del mismo payload.
- Igual para conexiones (prefijo `c-`).

### Resolución del token Linear en `/api/projects/linear/*`

1. Si existe `projects_dir/<cliente>/<proyecto>/.linear.token` → usar ese.
2. Si no → usar `backend/linear.token`.
3. Si no hay ninguno → 400 `{error: "No hay token de Linear ni en el proyecto ni global."}`.

Refactor mínimo en `linear_query()` (`server.py:194`): aceptar parámetro opcional `token`. Sin argumento, sigue usando el global → cero breaking change para los endpoints existentes.

### Errores

- 400 `{error: "..."}` para input inválido.
- 404 si `<cliente>/<proyecto>` no existe en disco.
- 500 + log detallado si falla el filesystem. El cliente recibe mensaje genérico, los detalles van al log del servicio.

## Sección 4 — Frontend

Trabajo total: ~3 cambios en `frontend/index.html`, ~1 bloque CSS y ~150-200 líneas nuevas en `frontend/app.js`.

### 4.1 Rename

Ver Sección 1.

### 4.2 Sub-pestañas dentro de un Proyecto

```html
<div class="proj-tabs">
  <button class="proj-tab active" data-view="repos">Repos</button>
  <button class="proj-tab" data-view="map">Mapa</button>
</div>
<div id="repos-area"> ... (contenido actual del #main-row) ... </div>
<div id="map-area" class="hidden"> ... (editor formulario) ... </div>
```

JS: handler de click en `.proj-tab` que toggle `.active` y muestra/oculta el área correspondiente.

### 4.3 Editor "Mapa" — formulario plano

Estructura visual:

```
─── Linear del proyecto ──────────────────────────────
  Token: [configurado ✓ / no configurado]
  [Configurar token]   [Borrar token]
  Fallback: usando token global de la VPS  (si aplica)

─── Servicios (zonas) ───────────────────────────────
  + Añadir servicio
  [vps]      VPS principal       host=1.2.3.4 ...    [Editar] [Borrar]
  [n8n]      n8n cliente X       on_host=vps-7f2a    [Editar] [Borrar]

─── Conexiones (cables) ─────────────────────────────
  + Añadir conexión
  n8n cliente X ──host──▶ VPS principal              [Borrar]

[ Guardar cambios ]   (deshabilitado si no hay cambios)
```

- **Añadir / editar servicio**: modal con `kind` (select), `name` (text), `config` (textarea con JSON; placeholder por kind). En editar, `kind` queda deshabilitado.
- **Añadir conexión**: modal con `from` y `to` (selects con servicios del proyecto por nombre) y `label` opcional.
- **Borrar servicio**: además de quitar el servicio del estado en memoria, el frontend borra automáticamente las conexiones huérfanas (las que referencian el servicio borrado) antes de habilitar "Guardar". Sin este paso el backend rechazaría el payload por inconsistencia y el usuario vería un 400 confuso.
- **Configurar token Linear**: modal con `<input type="password">` y botón "Guardar". Nunca se rellena con el valor actual.
- **Guardar cambios**: POST a `/api/projects/meta` con el objeto completo. Botón deshabilitado mientras no hay cambios.
- **Dirty tracking**: comparar `JSON.stringify` del estado en memoria con el último cargado.

### 4.4 Pestaña Linear del header contextual

- Variable global `currentProject = {client, project}` o `null`.
- Set al entrar a `repos` view (función `enterReposView`).
- Clear al volver a `clients` o `projects` view.
- En `setSection("linear")`:
  - Si `currentProject` → llamar a `/api/projects/linear/issues?client=...&project=...` y `/all`.
  - Si no → llamar a `/api/linear/issues` y `/api/linear/all` como hoy.
- Cabecera de la vista Linear muestra el contexto: "Linear global" o "Linear de Cliente / Proyecto" o "Linear de Cliente / Proyecto · token global (fallback)".

### 4.5 Estilo

CSS nuevo mínimo (estilos para `.proj-tabs`, `.svc-row`, `.conn-row`, modales). Reusar variables CSS existentes (`--text`, `--muted`, `--tool`, `--border`) para coherencia.

## Sección 5 — Compatibilidad, migración y seguridad

### Política de fallback Linear

- `/api/projects/linear/*` resuelve token: proyecto > global > 400.
- `/api/linear/*` (endpoints existentes) sigue usando solo el global. Sin cambio.
- `GET /api/projects/meta` devuelve `linear_status: {has_project_token, has_global_fallback}` para que la UI sepa qué token se va a usar.

### Sin migración automática

- Proyectos existentes arrancan con metadata vacía.
- `.panel.json` y `.linear.token` se crean al guardar por primera vez en el editor Mapa.

### Seguridad

- Permisos `600` en `.panel.json` y `.linear.token` (patrón actual: `panel.conf`, `linear.token`, `monitor.json`, `sessions.json`).
- El token Linear **nunca** sale del backend en respuestas API.
- Path traversal bloqueado por `valid_name` + `safe_join`.
- JSON inválido en disco: backend devuelve 500 con mensaje legible al cliente y NO sobrescribe el archivo. Logs detallados en el servidor.
- `.panel.json` y `.linear.token` añadidos al `.gitignore` del repo del panel (`AdelpozoBO/.gitignore`) por si alguien clona dentro del propio repo. No se modifica el `.gitignore` del usuario; los `projects_dir` suelen vivir fuera del repo del panel.

### Telemetría / logs

Cada cambio en `.panel.json` y `.linear.token` se loguea (timestamp, cliente, proyecto, acción) en el log del servicio. Sin contenido del token.

### Sin CLI

Toda la gestión vía UI. Flags `--export-meta` / `--import-meta` se difieren a futuro si surgen.

## Sección 6 — Verificación

El proyecto no tiene framework de tests hoy. Fase 1 ship con verificación manual con checklist. Introducir tests se difiere a Fase 2.

### Checklist (debe pasar antes de declarar Fase 1 completa)

**Rename y flujo básico**
- [ ] El botón del header dice "Proyectos".
- [ ] Crear Cliente → Proyecto → entrar al Proyecto funciona igual que antes.
- [ ] La pestaña "Repos" del proyecto sigue mostrando los repos como hoy.

**Editor Mapa happy path**
- [ ] Click "Mapa" en proyecto recién creado → editor vacío.
- [ ] Configurar token Linear → status "configurado". Recargar → sigue.
- [ ] Añadir 3 servicios (vps, n8n, chatwoot), guardar, recargar → persisten con ids.
- [ ] Añadir 2 conexiones, guardar, recargar → persisten.
- [ ] En disco: `projects_dir/<cliente>/<proyecto>/.panel.json` y `.linear.token` existen, ambos con permisos `-rw-------`.

**Linear contextual**
- [ ] Proyecto activo + token: pestaña Linear muestra issues del proyecto con cabecera "Linear de C / P".
- [ ] Proyecto activo sin token: muestra issues globales con aviso "usando token global (fallback)".
- [ ] Sin proyecto activo: pestaña Linear funciona como hoy con token global.

**Validaciones**
- [ ] `kind` fuera del enum → 400.
- [ ] Conexión a id inexistente → 400.
- [ ] `client=../foo` → 400.
- [ ] `name` vacío o > 100 chars → 400.
- [ ] > 100 servicios o > 500 conexiones → 400.
- [ ] Borrar token Linear → status "no configurado", `.linear.token` desaparece.

**Seguridad**
- [ ] El token Linear NO aparece en respuestas API (DevTools → Network).
- [ ] `ls -la` → permisos 600.
- [ ] `.panel.json` con JSON inválido → siguiente GET devuelve 500 legible, el archivo no se sobreescribe.
- [ ] `.panel.json` borrado a mano → siguiente GET devuelve estado vacío sin error.

**Compatibilidad**
- [ ] Proyectos sin `.panel.json` siguen funcionando en pestaña Repos.
- [ ] Pestaña Linear del header sin proyecto activo: funciona con token global como hoy.
- [ ] Pestaña Monitorización: sin cambios.

## Fases futuras (apuntadas, no parte de este spec)

- **Fase 2**: ingesta de monitorización por tipo de servicio (Chatwoot, Docker standalone, etc.). Reutiliza la infraestructura actual de Monitorización (SSH a host remoto). Cada `kind` gana un módulo de monitor con su schema de `config` validado.
- **Fase 3**: mapa 3D como home del panel. Three.js (o equivalente) por CDN. Renderiza ciudades (proyectos) → zonas (servicios del `.panel.json`) → cables (connections). Click en zona → modal con datos en vivo del monitor de Fase 2.

## Archivos a tocar / crear

- `frontend/index.html` (rename + tabs proj-tabs + modales)
- `frontend/app.js` (~150-200 líneas: editor, modales, currentProject, llamadas a nuevos endpoints)
- `frontend/styles.css` (~50 líneas: estilos de proj-tabs, svc-row, conn-row, modales)
- `backend/server.py` (~300 líneas: 5 endpoints nuevos, helpers de validación, refactor pequeño de `linear_query`)
- `backend/__panel_meta.py` o similar (opcional, si se quiere modularizar el cargar/guardar metadata por proyecto)
- `AdelpozoBO/.gitignore` (añadir `.panel.json` y `.linear.token`)
- `docs/superpowers/specs/2026-06-30-proyectos-mapa-fase1-design.md` (este documento)
