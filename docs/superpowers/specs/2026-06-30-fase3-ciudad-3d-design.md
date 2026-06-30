# Fase 3 — Ciudad 3D como home del panel

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

La Fase 1 (commit `7340e28`) cerró los cimientos: cada proyecto del panel persiste en disco una `.panel.json` con sus servicios (zonas) y conexiones (cables), y la edición se hace en un formulario plano en la sub-pestaña "Mapa" del proyecto. Sin visualización espacial.

La Fase 3 entrega la **visualización**: una **ciudad 3D isométrica** (estilo Sim City) como home del panel. Cada proyecto del panel = una ciudad. Cada servicio del proyecto = una zona dentro de la ciudad (primitiva 3D coloreada por kind). Cada conexión = un cable entre zonas. La cámara navega con pan/zoom; la cámara no rota. Click en ciudad → zoom-fly; click en zona → side panel con detalles.

La Fase 2 (monitor en vivo por tipo de servicio: Chatwoot, Docker standalone, etc.) puede no estar lista cuando se implemente Fase 3. La integración del monitor en vivo en el side panel se queda como placeholder y se cierra cuando Fase 2 esté disponible.

## Decisiones tomadas durante el brainstorming

1. **Estilo + interacción**: isométrico estilo Sim City. Cámara ortográfica fija a ~45°. Pan (drag de cámara) + zoom (wheel). Sin rotación de cámara.
2. **Técnica + assets**: Three.js + primitivas geométricas (boxes/cylinders/cones) coloreadas por `kind`. Cero assets que crear; todo es código. Three.js via CDN como única dependencia externa del frontend.
3. **Layout**: auto inicial + drag para mover. Posiciones se persisten en el `.panel.json` ampliado (version 2). Cities en grid auto si falta posición; zones en círculo regular dentro de su city.
4. **Navegación**: una sola escena con zoom continuo. Click ciudad → zoom-fly cinemático 600ms. Click zona → side panel desde la derecha. Hover → tooltip. Esc → cierra panel + zoom-out al mundo.
5. **UX co-existencia con Fase 1**: la pestaña "Mapa" del header (nueva, activa por defecto al loguearse) **convive** con la pestaña "Proyectos" (el grid CRUD actual). El formulario de Fase 1 dentro de cada proyecto **no se toca**; sigue siendo el editor canónico de servicios/conexiones.
6. **Edit Mode**: drag de cosas (ciudades, zonas) está **bloqueado por defecto** y se activa desde un botón en el HUD. Esto evita movimientos accidentales mientras paneas.
7. **Sin tests automatizados** en Fase 3 (mismo criterio que Fase 1, el proyecto no tiene framework).

## Sección 1 — UX y alcance

### Nueva pestaña "Mapa" en el header

Primera por la izquierda. Activa por defecto tras login. El header queda:

```
🟢 Claude  [Mapa] [Proyectos] [Monitorización] [Linear]   ... [☰] [Perfil] [Salir]
```

- La pestaña "Proyectos" **no se elimina**. Es la vista de gestión CRUD (renombrar/borrar clientes, proyectos, repos). El Mapa es la vista espacial. Se sincronizan: crear/borrar/renombrar en Proyectos se refleja en Mapa al siguiente render (y viceversa para borrados desde el side panel del Mapa).
- La sub-pestaña "Mapa" dentro de cada proyecto (formulario de Fase 1) **se queda exactamente igual**. La nueva pestaña "Mapa" del header es solo visualización 3D del mismo dato.

### Vista Mapa (lo que ves al entrar)

- Pradera/grid plano isométrico ocupando todo el área de contenido.
- Una ciudad por proyecto, posicionadas en grid auto inicial o donde las arrastraste.
- Cada ciudad: footprint rectangular con cartel encima `Cliente / Proyecto`.
- Dentro de cada ciudad: una zona (primitiva 3D coloreada) por servicio. Cables como líneas curvas entre zonas (solo intra-ciudad).
- HUD top-right con el toggle de Edit Mode y un botón "Volver al mundo" visible cuando estás zoom-in en una ciudad.

### Interacción base

- **Pan**: drag con click izquierdo sobre la pradera (no sobre una ciudad/zona).
- **Zoom**: rueda del ratón. Centrado en el cursor. Limitado a `frustumSize ∈ [5, 200]`.
- **Click izquierdo en ciudad**: zoom-fly animado 600ms al centro de esa ciudad.
- **Click izquierdo en zona**: side panel desde la derecha con detalles.
- **Hover sobre zona**: tooltip flotante 200ms delay con `kind · nombre`.
- **Drag en modo edición**: mueve la ciudad o la zona; persistido al soltar.
- **Esc**: cierra side panel, sale de Edit Mode, zoom-out al mundo.

### Empty state

- Sin proyectos: pradera vacía con cartel central "Aún no tienes proyectos. Crea uno para verlo aquí como ciudad" + botón "Crear proyecto" (lleva a la pestaña Proyectos).
- Proyecto sin servicios: la ciudad aparece como footprint con label + sub-label gris "ciudad sin zonas — añade servicios en Proyectos → Mapa". Click en la ciudad → side panel con `[ Abrir editor ]`.

## Sección 2 — Modelo de datos

`.panel.json` extiende a `version: 2` con dos campos nuevos, ambos opcionales:

```json
{
  "version": 2,
  "world_position": { "x": 0, "z": 0 },
  "services": [
    {
      "id": "vps-7f2a",
      "kind": "vps",
      "name": "VPS principal",
      "config": { "host": "1.2.3.4" },
      "position": { "x": 0, "z": 0 }
    }
  ],
  "connections": [
    { "id": "c-1a", "from": "vps-7f2a", "to": "n8n-9b41", "label": "host" }
  ]
}
```

### Reglas

- `world_position` y `position`: `{x, z}` con números finitos en rango `[-10000, 10000]`. Validación backend. `y` (altura) NO se persiste — el render la deriva del `kind`.
- Sistema de coordenadas: plano X/Z. 1 unidad ≈ 1 "casilla". Ciudad ocupa ~10×10 unidades. Grid spacing entre ciudades: 12 unidades.
- Auto-layout cuando falta `world_position`: grid determinista basado en `hash(cliente/proyecto)` → fila/columna.
- Auto-layout cuando falta `position` en una zona: círculo regular dentro de la ciudad.
- Persistencia: el frontend dispara `POST /api/projects/meta` **debounced 300ms** al soltar un drag, mandando el payload completo (full-replace, como Fase 1).
- Backwards-compat: `.panel.json` v1 sigue cargando; defaults aplicados; al primer drag queda upgradado a v2.
- Upgrade explícito: `validate_meta_payload()` siempre devuelve `version: 2` en el output normalizado; al primer guardado tras Fase 3, cualquier `.panel.json` v1 queda upgradado a v2 (sin migración previa: el upgrade ocurre orgánicamente al editar).

### Decisiones explícitas que NO entran al schema

- Escala / rotación: no se persisten. Tamaño fijo por kind, sin rotación.
- Color: derivado del kind en el frontend. No es config del usuario.
- Conexiones cross-ciudad: NO. Solo intra-ciudad (igual que Fase 1).

### Cambio backend mínimo

- `validate_meta_payload()` (Fase 1) acepta los nuevos campos opcionales con validación de tipo + rango.
- `load_project_meta()` rellena defaults `{x:0, z:0}` si faltan.
- `save_project_meta()` graba tal cual.

## Sección 3 — Arquitectura técnica frontend

### Dependencias nuevas (única excepción a la regla "sin libs")

- **Three.js 0.160.x via CDN** (ESM con importmap): `https://unpkg.com/three@0.160.0/build/three.module.js`.
- **CSS2DRenderer** addon de Three.js para etiquetas (HTML/CSS posicionado en 3D).
- Sin DragControls (manual, todo vive en Y=0). Sin GSAP (animaciones manuales con rAF).

### Archivos nuevos

- `frontend/map3d.js` — módulo entero del mapa. NO se mete en `app.js` (que ya tiene ~1000 líneas).
- `frontend/map3d.css` — estilos del contenedor + overlays.

### Cambios en archivos existentes

- `frontend/index.html`:
  - `<script type="importmap">` con `"three"` y `"three/addons/"`.
  - `<button id="tabMap">Mapa</button>` como primera pestaña del header.
  - `<div id="map-home" class="hidden">` con `<canvas>` + overlays (`#mapTooltip`, `#mapSidePanel`, `#mapEmptyState`, `#mapHud`).
  - `<link rel="stylesheet" href="/static/map3d.css">`.
- `frontend/app.js`:
  - `setSection("map")` añadido al switch de secciones.
  - Lazy: `import('/static/map3d.js')` y `initMap3D(...)` solo la primera vez que entras a "map" → Three.js no se descarga si no abres el mapa.

### Estructura de la escena Three.js

```
scene
├── lighting (AmbientLight + DirectionalLight desde arriba-izquierda)
├── ground (PlaneGeometry XZ, material con grid procedural)
├── worldGroup
│   ├── cityGroup_<client_project_id>
│   │   ├── footprint (BoxGeometry plano)
│   │   ├── label CSS2D (texto "Cliente / Proyecto")
│   │   ├── zoneMesh_<id> × N (primitiva por kind, coloreada)
│   │   └── cableLine_<id> × M (Line entre zonas, label opcional)
│   └── ... (una por proyecto)
└── helpers (axes en dev, ocultos en prod)
```

- Cámara: `OrthographicCamera` con rotación `(-π/4, π/4, 0)` para isométrico canónico. `frustumSize` controla el zoom.
- Renderer principal: `WebGLRenderer({ antialias: true, alpha: false })`. Segundo renderer `CSS2DRenderer` superpuesto para etiquetas.
- Render loop: `requestAnimationFrame` solo cuando hay cambios (dirty flag) o animaciones activas. Cuando la escena está quieta, no se renderiza.

### Picking + drag manual

- Raycaster desde `mousemove` (throttle 16ms). Hit → cursor + tooltip + outline. Sin hit → estado normal.
- `mousedown` → raycast. Hit en ciudad/zona (y Edit Mode ON) → start drag. Hit en suelo → start pan.
- `mousemove` con drag activo → raycast plane Y=0 → mueve la pieza (ciudad o zona).
- `mouseup` → si moviste algo: `persist()` debounced 300ms.
- Click vs drag: <5px = click, ≥5px = drag.

### Fly-to

Al click ciudad: animar `camera.position` + `frustumSize` durante 600ms con easing ease-in-out cuadrático. Cancelable si haces otro click.

### Performance

- < 50 proyectos × 10 zonas: trivial. Sin LOD.
- > 50: añadir LOD que oculta labels CSS2D de zonas a far zoom. `InstancedMesh` por kind si > 1000 zonas.
- Para Fase 3 NO se implementa LOD; comentario `// LOD aquí cuando haga falta`.

### Nuevo endpoint backend `GET /api/world`

Para evitar N+1 fetches en la carga inicial:

```json
{
  "clients": [
    {
      "name": "DiveAcademy",
      "projects": [
        {
          "name": "Panel",
          "meta": {
            "world_position": { "x": 0, "z": 0 },
            "services": [...],
            "connections": [...]
          }
        }
      ]
    }
  ]
}
```

- Itera carpetas en `projects_dir`, lee cada `.panel.json` (v1 o v2; defaults aplicados).
- NUNCA incluye `.linear.token` ni nada secreto.
- Sin paginar — son pocos proyectos.

## Sección 4 — Interacciones detalladas

### Side panel al click en zona

Anclado a la derecha, ancho 360px, slide-in 200ms.

```
[Cliente / Proyecto / VPS principal]              [×]
─────────────────────────────────────────────────────
  [vps] badge   VPS principal

  Config
  ┌────────────────────────────────────────────┐
  │ {                                           │
  │   "host": "1.2.3.4",                       │
  │   "user": "adelpozor",                     │
  │   "port": 22                                │
  │ }                                           │
  └────────────────────────────────────────────┘

  Estado
  ┌────────────────────────────────────────────┐
  │ Monitor en vivo: disponible en Fase 2      │
  └────────────────────────────────────────────┘

  Conexiones
  • n8n cliente X → este (label: host)
  • este → postgres (label: queries)

  [ Editar en formulario ]   [ Borrar zona ]
```

- "Editar en formulario": cambia `setSection("dev")` → entra al proyecto → activa sub-pestaña Mapa (Fase 1) → scroll-into-view del servicio.
- "Borrar zona": confirmación → POST meta sin esa zona + conexiones huérfanas limpiadas → cierra side panel.

### Side panel al click en ciudad

Variante reducida: header `[Cliente / Proyecto]`, contador de zonas/conexiones, botones `[ Abrir editor ]` `[ Renombrar proyecto ]` `[ Borrar proyecto ]`. Renombrar/borrar usan los endpoints existentes (`/api/projects/rename`, `/api/projects/delete`).

### Tooltip

Delay 200ms, sigue al cursor.

- Sobre zona: `kind · nombre`. Ej: `vps · VPS Hostinger`.
- Sobre ciudad: nombre del proyecto.
- Sobre cable: la `label` si existe; nada si no.

### Edit Mode (HUD top-right)

```
┌──────────────────┐
│ 🔒 Layout fijo   │ ← click toggle
│ 🌍 Ver mundo     │ ← visible si zoom-in
└──────────────────┘
```

- Default OFF. Drag en ciudad/zona = pan de cámara mientras está OFF.
- Toggle ON: drag activa. Cursor "move" al hover. Al guardar (debounced), check ✓ verde aparece y desvanece ~1s.
- Esc: cierra side panel + sale de Edit Mode + zoom-out al mundo.

### Pan / zoom límites

- Pan: cámara no se aleja más de 3× el bounding-box del mundo. Elasticidad suave al sobrepasar.
- Zoom: `frustumSize ∈ [5, 200]`. Centrado en el cursor (zoom hacia el punto donde está el ratón).

### Fly-to al click ciudad

- Anima 600ms con easing ease-in-out cuadrático.
- Cancelable al volver a clicar.
- Destino: `frustumSize=30` (ver la ciudad entera y sus zonas).

### Empty state

- Sin proyectos en absoluto: pradera vacía con cartel "Aún no tienes proyectos. Crea uno para verlo aquí como ciudad" + botón "Crear proyecto" → `setSection("dev")` + dialog "+ Nuevo cliente"/"+ Nuevo proyecto".
- Proyecto sin servicios: ciudad pequeña con label + sub-label gris "ciudad sin zonas — añade servicios en Proyectos → Mapa". Click → side panel con `[ Abrir editor ]`.

### Atajos de teclado

- `Esc`: cierra side panel + sale de Edit Mode + zoom-out al mundo. Si hay un drag en curso, lo cancela y la pieza vuelve a su posición de inicio (no se persiste).
- (YAGNI el resto; añadimos si surgen.)

## Sección 5 — Verificación, archivos y caveats

### Checklist manual (debe pasar antes de declarar Fase 3 completa)

**Boot y carga inicial**
- [ ] Tras login, pestaña activa por defecto = "Mapa".
- [ ] Sin proyectos → empty state grande + botón "Crear proyecto".
- [ ] Con proyectos → ciudades en grid auto.
- [ ] Three.js cargado solo al primer setSection("map") (Network tab).
- [ ] `GET /api/world` se llama una sola vez en la carga inicial.

**Navegación**
- [ ] Wheel → zoom centrado en cursor.
- [ ] Drag en suelo → pan.
- [ ] Wheel demasiado → clamp `frustumSize ∈ [5, 200]`.
- [ ] Pan demasiado lejos → elasticidad de vuelta al soltar.
- [ ] Click en ciudad → fly-to 600ms.
- [ ] Esc → cierra panel, sale Edit Mode, zoom-out al mundo.

**Edit Mode**
- [ ] Default OFF: drag en ciudad/zona = pan.
- [ ] Toggle ON: cursor "move" al hover; drag mueve.
- [ ] Al soltar, check ✓ verde + persistido. Recarga → posición persistida.
- [ ] Coords fuera de rango → backend 400 (verificar con curl).

**Side panel zona**
- [ ] Click zona → slide-in.
- [ ] Muestra: badge, nombre, JSON config, placeholder monitor, conexiones.
- [ ] "Editar en formulario" → navega a sub-pestaña Mapa de Fase 1.
- [ ] "Borrar zona" → desaparece + conexiones huérfanas limpiadas + side panel cerrado.
- [ ] Click en suelo o Esc → cierra side panel.

**Side panel ciudad**
- [ ] Click label/footprint → side panel reducido.
- [ ] Renombrar/borrar refleja sin recargar.

**Tooltip**
- [ ] Hover 200ms → tooltip aparece.
- [ ] Mover ratón fuera → tooltip oculto.

**Datos**
- [ ] `.panel.json` v1 (sin posiciones) carga + auto-asigna sin error.
- [ ] Tras drag, recarga → posición persistida con `version: 2`.
- [ ] `GET /api/world` NO incluye `linear.token` ni secretos.

**Compatibilidad**
- [ ] Pestaña Proyectos: idéntica.
- [ ] Sub-pestaña Mapa de Fase 1: idéntica.
- [ ] Pestaña Linear: idéntica.
- [ ] Pestaña Monitorización: idéntica.

### Archivos a crear

- `frontend/map3d.js` (~600-800 líneas)
- `frontend/map3d.css` (~100 líneas)
- `docs/superpowers/specs/2026-06-30-fase3-ciudad-3d-design.md` (este spec)

### Archivos a modificar

- `frontend/index.html` — importmap Three.js + `#tabMap` + `#map-home` + overlays + link CSS.
- `frontend/app.js` — `setSection("map")` + lazy import.
- `backend/server.py`:
  - Nuevo endpoint `GET /api/world` (~30 líneas).
  - Extender `validate_meta_payload()` para `world_position` + `position`.
  - Extender `load_project_meta()` para rellenar defaults.

### Caveats explícitos (lo que NO entra en Fase 3)

1. **Monitor en vivo por zona**: placeholder "disponible en Fase 2".
2. **Conexiones cross-ciudad**: NO. Solo intra-ciudad.
3. **Animación / efectos**: solo fly-to + tooltip + slide-in. Sin cables pulsantes, sin partículas, sin shaders custom.
4. **Mobile**: funciona pero no optimizado.
5. **Multi-selección de zonas**: NO.
6. **Persistir zoom/posición de cámara**: NO.
7. **Búsqueda / filtro**: NO.

### Fases siguientes (apuntadas, no parte de este spec)

- **Fase 4**: monitor en vivo integrado en el side panel (depende de Fase 2). Cables con color/grosor según tráfico/estado.
- **Fase 5**: editar zona desde el side panel sin saltar al formulario (campo `kind` no editable; `name` y `config` sí).
- **Fase 6**: persistir cámara, conexiones cross-ciudad, multi-selección, búsqueda, animaciones de cables pulsantes.
