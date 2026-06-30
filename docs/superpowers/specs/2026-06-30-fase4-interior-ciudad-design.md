# Fase 4 — Interior de la ciudad (drill-in con barrios y carreteras)

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

La Fase 3 (commit `e122de6`) entregó el mapa 3D isométrico como home del panel: cada proyecto del usuario es una ciudad, cada servicio una zona coloreada por kind, los cables son conexiones entre zonas. Pan/zoom, click ciudad = fly-to + side panel, click zona = side panel con info.

La Fase 4 añade el **drill-in al interior** de una ciudad: pulsas "Entrar" en el side panel de una ciudad y la escena cambia de la vista mundo a una vista interior donde solo se ve ESA ciudad, organizada por **barrios** (uno por kind) con sus componentes dentro y los cables existentes renderizados con look de carretera. Al clicar un componente, el side panel se enriquece con un bloque de **estado** y **métricas** simuladas (mock animado) — porque la Fase 2 (ingesta real de monitor por kind) todavía no existe; cuando esté, las mismas casillas se rellenan con datos en vivo sin rediseñar la UI.

La idea del usuario, literal: "poder entrar en cada ciudad y ver las calles, dentro de cada ciudad por 'barrios' ver cada uno de las cosas que se monitoriza para poder recoger información del componente".

## Decisiones tomadas durante el brainstorming

1. **Barrios por kind**: cada tipo de servicio (vps, n8n, docker, chatwoot, postgres, github, linear, custom) es su propio barrio. Sin schema nuevo. Sin grupos manuales.
2. **Calles = cables existentes con look de carretera** (cosmético; sin grid auto-generado). Los `connections` del `.panel.json` se renderizan en interior como tubos asfalto + líneas blancas dashed encima.
3. **Drill-in vía botón "Entrar en ciudad"** en el side panel reducido de ciudad (Fase 3 ya muestra ese panel al click). Salida con Esc o botón HUD "← Volver al mundo".
4. **Interior limpio y minimalista**: mismas primitivas de Fase 3 a escala 2x, barrios planos coloreados (alpha 0.25), labels CSS2D con indicador de estado. Sin edificios temáticos, sin shaders, sin partículas. (Eye-candy → Fase 5 si llega.)
5. **Métricas mock animadas para todos**: status fijo por sesión via hash(serviceId), valores que cambian cada 2s con jitter realista. Cartel claro "datos simulados · conectar Fase 2". Cuando Fase 2 esté lista, las mismas casillas se rellenan con datos reales.
6. **Sin tests automatizados** en F4 (mismo criterio que F1/F3). Verificación manual con checklist.
7. **Cero cambios en `.panel.json`**: schema `version: 2` queda igual. Todo el interior se deriva de los datos existentes.

## Sección 1 — UX y alcance

### Punto de entrada al interior

Nuevo botón **"» Entrar en la ciudad"** en el side panel reducido de ciudad (el que aparece hoy al clicar el footprint de una ciudad). Botón colocado como primera acción, antes de "Abrir editor". Cero cambios en el flujo existente del side panel de ciudad.

### Modo de escena (sceneMode)

- `world`: vista de Fase 3. Pradera + todas las ciudades + drag/pan/zoom.
- `interior:<cliente>/<proyecto>`: vista nueva. Pradera y ciudades del mundo OCULTAS. En el origen aparece la representación interior de la ciudad elegida.

### Vista interior

ASCII de muestra:

```
   ╔═════════════════════════════════════════════════════╗
   ║              barrio Chatwoot (▲ naranja claro)        ║
   ║                    △  △                                ║
   ║                                                       ║
   ║   barrio VPS                       barrio n8n         ║
   ║   (■ gris claro)                   (⛈ morado claro)   ║
   ║   ■ host1                          ⛈ flow-prod         ║
   ║   ■ host2                          ⛈ flow-staging      ║
   ║   ■ host3                                              ║
   ║              ──carretera─── (cable)                   ║
   ║              barrio postgres (● azul claro)            ║
   ║                    ● db                                ║
   ╚═══════════════════════════════════════════════════════╝
   [← Volver al mundo]                       (HUD top-right)
```

### Componentes interactivos del interior

- **Barrios**: uno por cada `kind` presente en `services[]` del proyecto. Footprint circular plano alpha 0.25 coloreado por kind. Label CSS2D "barrio <kind>" arriba.
- **Componentes**: misma primitiva de Fase 3 a escala 2x. Label CSS2D arriba: `[●] <nombre>` donde `●` es el indicador de status mock (verde/ámbar/rojo).
- **Carreteras**: las conexiones intra-ciudad existentes, renderizadas con material asfalto + líneas blancas dashed.
- **Hover componente** → tooltip enriquecido (2 líneas: `kind · nombre` / `estado actual`).
- **Click componente** → side panel a la derecha enriquecido (ver Sección 4).
- **Click suelo / barrio vacío** → cierra side panel si abierto. NO sale del interior.

### Salida del interior

- **Esc**: cierra panel primero si abierto; segundo Esc o sin panel → exitCity().
- **Botón HUD "← Volver al mundo"**: siempre visible en interior. Click → exitCity().

### HUD adaptado

- En `world`: HUD muestra `🔒 Layout fijo` (Edit Mode toggle de Fase 3).
- En `interior`: HUD muestra `← Volver al mundo` ÚNICAMENTE. El toggle de Edit Mode se OCULTA (no aplica: no se puede arrastrar en interior).

### Empty state

- Ciudad sin servicios → al entrar, cartel central "Ciudad vacía. Añade servicios en el editor (Proyectos → Mapa)" + botón "← Volver al mundo".

## Sección 2 — Modelo de datos

**`.panel.json` no cambia.** Schema `version: 2` queda igual. Razones:

- Los barrios son derivados del `kind` (campo ya existente). Sin nuevo campo.
- El layout interior es totalmente auto-generado por el frontend a partir de la lista de services + kinds. No se persiste posición interior; la `position` del schema sigue siendo solo para el world view de Fase 3.
- Las métricas mock viven solo en memoria del frontend. No se persisten.

### Estado en memoria del cliente (NO en disco)

```javascript
mockMetrics: Map<serviceId, {
  status: "ok" | "warn" | "down",   // derivado de hash(serviceId) — fijo por sesión
  cpu: number,                       // 0-100
  ram: number,                       // 0-100
  disk: number,                      // 0-100
  uptimeSeconds: number,
  lastUpdate: number,                // timestamp
}>
```

### Derivación inicial (primera vez que se entra a una ciudad en la sesión)

Para cada service del proyecto:

- `h = hash(serviceId)` (DJB2 o similar, 32-bit unsigned).
- `status`: `h % 10` → 0-6=ok (70%), 7-8=warn (20%), 9=down (10%).
- `cpu`: `20 + (h % 60)` → rango 20-80.
- `ram`: `30 + ((h >> 8) % 50)` → rango 30-80.
- `disk`: `10 + ((h >> 16) % 70)` → rango 10-80.
- `uptimeSeconds`: `86400 + ((h >> 4) % (86400 * 30))` → 1 a 30 días.

### Tick (cada 2000ms, solo mientras `sceneMode.startsWith("interior")`)

- `cpu += rand(-3, +3)`, clamp [0, 100].
- `ram += rand(-2, +2)`, clamp [0, 100].
- `disk += rand(-0.5, +0.5)`, clamp [0, 100].
- `uptimeSeconds += 2`.
- `status` NO cambia.
- Si hay side panel abierto y muestra métricas → re-renderizar solo los números visibles.

### Persistencia

Cero. Los valores mock se conservan en memoria mientras dura la sesión del navegador. Al recargar página se re-inicializan desde hash (mismos valores estables por servicio para esa sesión). Cuando llegue Fase 2, esta capa mock se reemplaza por un fetch a `/api/monitor/...` por service — la UI del side panel queda igual.

### Backend

Cero cambios. Ningún endpoint nuevo. Ningún campo nuevo en `panel.conf` ni en `.panel.json`.

## Sección 3 — Arquitectura técnica

### Sin archivos nuevos

Toda la Fase 4 vive en los archivos existentes:

- `frontend/map3d.js` (~+500 líneas).
- `frontend/map3d.css` (~+50 líneas).

### Estado nuevo en map3d.js

```javascript
let sceneMode = "world";              // "world" | "interior:<client>/<project>"
let interiorGroup = null;             // THREE.Group del interior (null en world)
let worldCameraSnapshot = null;       // {position, frustumSize} para restaurar
const mockMetrics = new Map();        // serviceId → {status, cpu, ram, disk, uptimeSeconds, lastUpdate}
let mockTicker = null;                // setInterval handle
```

### API pública nueva

```javascript
export function enterCity(client, project) { ... }
export function exitCity() { ... }
```

### Algoritmo de layout interior

1. Recoger `services` del proyecto, agrupar por `kind` → `barriosMap = Map<kind, services[]>`.
2. Para cada `kind` en `barriosMap`, crear un `THREE.Group` "barrio":
   - **Footprint**: `CircleGeometry(4, 32)` plano en Y=0, material `MeshBasicMaterial({color: ZONE_COLORS[kind], opacity: 0.25, transparent: true, side: THREE.DoubleSide})`. Rotado para descansar en el plano XZ.
   - **Label CSS2D** "barrio <kind>" anclado a Y=0.5 sobre el centro del barrio.
3. Distribuir los N barrios alrededor de (0,0,0):
   - N=1 → en el centro.
   - N≥2 → polar: `angle_i = 2π · i / N`, `radius = 10`. `barrio[i].position = (R·cos(angle), 0, R·sin(angle))`.
4. Dentro de cada barrio, distribuir sus services en círculo interior:
   - `M = services.length`.
   - Para `i ∈ [0, M)`: `angle = 2π · i / max(M, 3)`, `radius = 2`. Mesh local pos = `(r·cos, ZONE_Y, r·sin)`.
   - Mesh = `new THREE.Mesh(ZONE_PRIMITIVES[kind](), MeshStandardMaterial({color: ZONE_COLORS[kind]}))`. Aplicar `mesh.scale.set(2, 2, 2)`.
   - `userData = {type: "zone", service, client, project, inInterior: true}` (flag para distinguir del world).
   - Label CSS2D arriba: HTML `<div class="zone-label"><span class="status-dot status-<status>"></span><span>{name}</span></div>`.
5. **Cables / carreteras**: para cada conexión cuyos `from`/`to` están entre los services del proyecto:
   - Buscar los meshes en el `interiorGroup` por id, sacar sus posiciones WORLD (mesh.getWorldPosition).
   - Construir un `CatmullRomCurve3` entre los dos puntos (curva sutil).
   - `TubeGeometry(curve, 16, 0.1, 8)` con `MeshBasicMaterial({color: 0x333740})` → asfalto.
   - Encima, una `Line` con la misma curva: `LineDashedMaterial({color: 0xffffff, dashSize: 0.4, gapSize: 0.4, linewidth: 1})`. Llamar `computeLineDistances()` para que las dashes funcionen.

### Transiciones

```javascript
function enterCity(client, project) {
  worldCameraSnapshot = { position: camera.position.clone(), frustumSize: camera.userData.frustumSize };
  worldGroup.visible = false;
  interiorGroup = buildInterior(client, project);
  scene.add(interiorGroup);
  initMockMetricsForServices(servicesOf(client, project));
  camera.position.set(50, 50, 50);
  setFrustum(25);
  camera.lookAt(0, 0, 0);
  sceneMode = `interior:${client}/${project}`;
  showHudInterior(true);
  if (sidePanelOpen) closeSidePanel();
  startMockTicker();
  markDirty();
}

function exitCity() {
  if (mockTicker) { clearInterval(mockTicker); mockTicker = null; }
  if (interiorGroup) { scene.remove(interiorGroup); disposeGroup(interiorGroup); interiorGroup = null; }
  worldGroup.visible = true;
  if (worldCameraSnapshot) {
    camera.position.copy(worldCameraSnapshot.position);
    setFrustum(worldCameraSnapshot.frustumSize);
    worldCameraSnapshot = null;
  }
  sceneMode = "world";
  showHudInterior(false);
  if (sidePanelOpen) closeSidePanel();
  markDirty();
}
```

### Mock ticker

```javascript
function startMockTicker() {
  mockTicker = setInterval(() => {
    if (!sceneMode.startsWith("interior")) return;
    for (const [id, m] of mockMetrics) {
      m.cpu  = clamp(m.cpu  + (Math.random() * 6 - 3), 0, 100);
      m.ram  = clamp(m.ram  + (Math.random() * 4 - 2), 0, 100);
      m.disk = clamp(m.disk + (Math.random() * 1 - 0.5), 0, 100);
      m.uptimeSeconds += 2;
      m.lastUpdate = Date.now();
    }
    // Si el side panel está mostrando un service con metrics, re-pintar los números
    refreshOpenPanelMetrics();
    markDirty();   // por si actualizo algún label CSS2D que cuelga del status
  }, 2000);
}
```

### Side panel enriquecido

`openZonePanel(zoneMesh)` actual ya está. Para Fase 4, se le añade lógica condicional: si `zoneMesh.userData.inInterior === true`, intercala 2 bloques nuevos justo después del header del panel y antes del bloque Config:

```html
<div class="sp-block">
  <h4>Estado (simulado)</h4>
  <div class="sp-status-row">
    <span class="status-dot status-{ok|warn|down}"></span>
    <span>{textoEstado} · datos simulados · conectar Fase 2</span>
  </div>
</div>
<div class="sp-block">
  <h4>Métricas (simuladas)</h4>
  <div class="metric"><span>CPU</span><span data-metric="cpu">{cpu}%</span>
    <div class="bar"><div data-metric-bar="cpu" style="width:{cpu}%"></div></div></div>
  <div class="metric"><span>RAM</span><span data-metric="ram">{ram}%</span>
    <div class="bar"><div data-metric-bar="ram" style="width:{ram}%"></div></div></div>
  <div class="metric"><span>Disk</span><span data-metric="disk">{disk}%</span>
    <div class="bar"><div data-metric-bar="disk" style="width:{disk}%"></div></div></div>
  <div class="metric-uptime">Uptime: {humanUptime}</div>
</div>
```

En modo `world`, esos bloques NO se renderizan; el side panel queda como hoy (bloque "Estado: Monitor en Fase 2" estático).

`refreshOpenPanelMetrics()` actualiza solo los `[data-metric]` y `[data-metric-bar]` sin re-renderizar el panel entero — evita parpadeo de scroll y re-binding de handlers.

### HUD

Cambios mínimos al `#mapHud`:

- En `world`: solo `#mapEditToggle` (igual que Fase 3).
- En `interior`: solo `#mapBackBtn` ("← Volver al mundo"). El `#mapEditToggle` queda oculto.

Helper:

```javascript
function showHudInterior(inInterior) {
  $("#mapEditToggle").classList.toggle("hidden", inInterior);
  $("#mapBackBtn").classList.toggle("hidden", !inInterior);
}
```

Botón HTML nuevo en `index.html` dentro de `#mapHud`:

```html
<button id="mapBackBtn" class="hud-btn hidden" title="Volver al mundo">← Volver al mundo</button>
```

### Cámara y input en interior

- Misma `OrthographicCamera`. Pan y zoom siguen funcionando con límites más estrechos: `frustumSize ∈ [10, 40]`.
- Drag de componentes/barrios: DESACTIVADO. Si el usuario tenía Edit Mode ON antes de entrar, internamente se considera OFF mientras esté en interior; al salir, vuelve a su estado previo.
- Raycaster y picking reutilizados. Distingue zones del world (worldGroup) vs zones del interior (interiorGroup) por el flag `userData.inInterior`.

### CSS nuevo

```css
/* Estado y métricas en side panel (Fase 4) */
.sp-status-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text); }
.status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.status-ok   { background: #22c55e; box-shadow: 0 0 4px #22c55e; }
.status-warn { background: #f59e0b; box-shadow: 0 0 4px #f59e0b; }
.status-down { background: #ef4444; box-shadow: 0 0 4px #ef4444; }

.metric { display: grid; grid-template-columns: 50px 50px 1fr; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 4px; }
.metric .bar { background: rgba(255,255,255,0.08); border-radius: 4px; height: 6px; overflow: hidden; }
.metric .bar > div { background: var(--text); height: 100%; transition: width 1s ease-out; }
.metric-uptime { font-size: 12px; color: var(--muted); margin-top: 6px; }

/* Label CSS2D de zona en interior */
.zone-label { display: flex; align-items: center; gap: 6px; background: rgba(13,17,23,0.92); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; font-size: 11px; }
.barrio-label { background: rgba(13,17,23,0.85); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 2px 10px; font-size: 11px; text-transform: lowercase; }

/* Botón "Volver al mundo" del HUD */
#mapBackBtn { background: rgba(40,55,90,0.92); }
#mapBackBtn:hover { background: rgba(60,75,110,0.95); }
```

## Sección 4 — Verificación, archivos y caveats

### Checklist manual

**Entrada/salida**
- [ ] Click ciudad (footprint) → side panel reducido con nuevo botón "» Entrar en la ciudad" como primera acción.
- [ ] Click "Entrar" → pradera y ciudades world OCULTAS. Aparecen barrios y componentes de ESA ciudad en el origen.
- [ ] Cámara centrada en (0,0,0), frustumSize ≈ 25.
- [ ] HUD: aparece "← Volver al mundo", se oculta "🔒 Layout fijo".
- [ ] Click "← Volver al mundo" → world restaurada exactamente como antes (cámara, zoom).
- [ ] Esc con panel abierto → cierra panel. Otro Esc → exitCity.
- [ ] Esc sin panel → exitCity directamente.

**Layout interior**
- [ ] N=1 barrio → único en (0,0,0).
- [ ] N=2-8 barrios → distribución polar a 360/N grados, radio 10.
- [ ] Cada barrio: footprint circular alpha 0.25 con color del kind + label CSS2D "barrio <kind>".
- [ ] Componentes dentro: primitiva escala 2x, en círculo interior radio 2.
- [ ] Label componente: `[●] <nombre>` con color del status.
- [ ] Cables intra-ciudad: renderizados como tubo asfalto + líneas blancas dashed.
- [ ] Sin conexiones → no hay cables; barrios y componentes solos.

**Mock metrics**
- [ ] Cada componente tiene status fijo durante toda la sesión (entrar/salir N veces → mismo status).
- [ ] Tick cada 2s: cpu/ram/disk cambian con jitter pequeño, uptime +2s.
- [ ] Side panel abierto con metrics → números visibles se actualizan en vivo (sin parpadeo del panel).
- [ ] Cartel "datos simulados · conectar Fase 2" visible en bloque Estado.

**Side panel**
- [ ] Click componente en interior → panel con: header, bloque Estado (con dot color + cartel mock), bloque Métricas (4 valores con barras), bloque Config, bloque Conexiones, botones "Editar en formulario" / "Borrar zona".
- [ ] Click componente en world (sin entrar a ciudad) → panel como Fase 3 (sin Métricas; bloque Estado dice "Monitor en Fase 2"). Sin regresión.
- [ ] "Editar en formulario" desde interior → exitCity primero, luego navega a Proyectos / cliente / proyecto / Mapa, destaca fila.
- [ ] "Borrar zona" desde interior → confirmación → POST `/api/projects/meta` sin esa zona + conexiones huérfanas → desaparece del barrio + cierra panel. Si era la última del barrio, el barrio se elimina del interior. Si era la última del proyecto, queda empty state interior.

**Empty state interior**
- [ ] Entrar a ciudad sin servicios → cartel central "Ciudad vacía..." + botón "← Volver al mundo".

**No regresiones de Fase 3**
- [ ] World: pan, zoom, drag (Edit Mode), fly-to, side panel ciudad, side panel zona, todo funciona.
- [ ] Pestaña Proyectos: idéntica.
- [ ] Pestaña Monitorización: idéntica.
- [ ] Pestaña Linear: idéntica.
- [ ] Tras CRUD en pestaña Proyectos → world se refresca. Si tenías interior abierto, se cierra (exitCity) y el world se reconstruye.

### Archivos a tocar

**Modificar:**
- `frontend/map3d.js` (~+500 líneas: estado nuevo, enterCity/exitCity, buildInterior + barrios + roads, mockMetrics + ticker, openZonePanel enriquecido, refreshOpenPanelMetrics, HUD adaptado, Esc encadenado, openCityPanel con botón "Entrar").
- `frontend/map3d.css` (~+50 líneas: status-dot, metric, bar, zone-label, barrio-label, mapBackBtn).
- `frontend/index.html` (~+1 línea: `<button id="mapBackBtn">` dentro de `#mapHud`).

**Crear:**
- `docs/superpowers/specs/2026-06-30-fase4-interior-ciudad-design.md` (este spec).
- `docs/superpowers/plans/2026-06-30-fase4-interior-ciudad-plan.md` (tras aprobación, vía writing-plans).

**Backend:** cero cambios.

### Caveats explícitos (lo que NO entra en Fase 4)

1. **Monitor real**: mock. La integración real depende de Fase 2.
2. **Edificios temáticos por kind**: NO. Mismas primitivas a escala 2x.
3. **Animaciones de tráfico en cables**: NO.
4. **Drag dentro del interior**: NO. Solo inspección.
5. **Sub-componentes** (CPU/RAM como zonas dentro de un VPS): NO.
6. **Persistencia de cualquier estado interior** (mock, layout, cámara): NO.
7. **Barrios manuales / agrupaciones custom**: NO.
8. **Conexiones cross-ciudad**: NO (mismo límite que F1/F3).
9. **Búsqueda dentro de la ciudad**: NO.
10. **Atajos de teclado más allá de Esc**: NO.

### Fases siguientes (apuntadas)

- **Fase 5**: edificios temáticos por kind (modelos 3D o sprites compuestos), animaciones de tráfico en cables, ambient sounds opcionales.
- **Fase 6** (cuando Fase 2 esté lista): reemplazar mock por datos reales del monitor sin tocar la UI del side panel.
- **Fase 7+**: sub-componentes navegables, búsqueda dentro de ciudad, persistencia de estado interior, conexiones cross-ciudad.
