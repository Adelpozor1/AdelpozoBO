# Fase 5 — Edificios temáticos + star topology + mini-ciudades en world

Fecha: 2026-06-30
Estado: aprobado para implementación.

## Contexto

La Fase 4 (commit `40a6999`) entregó el drill-in al interior de la ciudad con barrios agrupados por rol semántico, cables como carreteras y mock metrics en el side panel. Visualmente las zonas seguían siendo primitivas 3D escala 2x dentro de footprints circulares planos coloreados; el world view (Fase 3) seguía con primitivas individuales por servicio.

Tras la verificación en local, el usuario pidió **subir el listón visual**: literalmente "cambia los cubos por mapas virtuales de ciudad, luego cuando entro en la ciudad debe ver un mapa, algo sencillo, de las calles, carreteras y demás y ver cada edificio con cada servicio. El VPS es el 'ayuntamiento' y luego de la misma carretera el resto de servicios".

La Fase 5 reemplaza las primitivas por **edificios temáticos compuestos de primitivas Three.js** (sin assets externos) y reorganiza el interior con **topología en estrella**: ayuntamiento (primer VPS) en una plaza central, calles radiales por cada barrio NO infraestructura, edificios alineados a los lados de su calle. En el world view, cada ciudad se renderiza como **mini-cluster** de edificios para que sea reconocible desde lejos como una ciudad mini en vez de un footprint plano con cubos.

## Decisiones tomadas durante el brainstorming

1. **Layout de calles en interior**: **topología en estrella** (plaza central + ramificaciones radiales). Una calle por cada barrio NO infraestructura. Ayuntamiento (VPS) en la plaza; el barrio "infraestructura" entero (VPSs adicionales + dockers) vive en torno a la plaza.
2. **Edificios temáticos**: composiciones simples de primitivas Three.js, declaradas en `BUILDING_RECIPES` (estructura de datos interpretada por un loop). Cero assets externos. 8 kinds → 8 recetas.
3. **Alcance**: world view **también** cambia (las primitivas individuales pasan a ser clusters mini de hasta 5 edificios). El usuario lo pidió textualmente.
4. **Reordenar layout más adelante**: en F5 NO hay UI de drag dentro del interior. Solo se prepara el schema con `interior_position` opcional para que F6 pueda añadir el drag sin migración.
5. **Sin animaciones, sin sonidos, sin shaders custom**: F5 entrega visual estático. Eye-candy → F7.
6. **Sin tests automatizados** (mismo criterio que F1/F3/F4).

## Sección 1 — UX y alcance

### Cambios en world view

Hoy cada ciudad: footprint plano + primitivas individuales por servicio en círculo. Después:

- Footprint plano se mantiene (`BoxGeometry(10, 0.15, 10)`).
- Encima, en vez de las primitivas individuales, un **cluster compacto de mini-edificios**:
  - **Edificio central**: ayuntamiento (primer servicio con `kind="vps"` por orden de id), escala 0.5. Si no hay VPS, el primer servicio del proyecto cualquiera que sea su kind.
  - **Hasta 4 edificios secundarios**: escogidos por orden, escala 0.4, distribuidos alrededor del central en offsets fijos `(±2.5, ±2.5)` (cuadrado).
  - Si el proyecto tiene **> 5 servicios totales**: solo se renderizan los 5 primeros + label CSS2D **"+N más"** sobre el cluster.
- Label "Cliente / Proyecto" sigue arriba como hoy.
- **Hover, click footprint, click edificio, drag**: comportamiento idéntico a F3/F4. Cero cambio en API de interacciones.

### Cambios en interior (drill-in)

Hoy: footprints circulares planos por rol + primitivas escala 2x dentro en círculo. Después:

- **Plaza central** en `(0, 0, 0)`:
  - **Ayuntamiento**: primer servicio con `kind="vps"`. Edificio temático VPS centrado.
  - **VPSs adicionales + dockers** (resto del barrio infraestructura): alrededor del ayuntamiento, círculo radio 3.5, ángulos uniformes.
- **Barrios NO infraestructura** (base de datos, backend, comunicaciones, código, gestión, otros): uno por cada rol presente, cada uno con una **calle radial**:
  - Calle = rectángulo plano `BoxGeometry(1.2, 0.05, 8)` color asfalto `#333740` + líneas blancas dashed encima (`LineDashedMaterial`).
  - Cada barrio en `angle_i = 2π · i / N_barrios_no_infra`.
  - Calle parte de `radius = 6` y termina en `radius = 14`, rotada para apuntar al ángulo del barrio.
  - **Label "calle <rol>"** CSS2D al inicio de la calle (cerca de la plaza).
  - **Edificios** alineados a ambos lados de la calle, alternando izquierda/derecha, offset perpendicular ±1.6 unidades, espaciado a 2 unidades a lo largo de la calle. Hasta 4 a cada lado por calle.
- **Cables intra-ciudad** (los del `.panel.json`) siguen renderizándose como F4 (tubo asfalto + dashed) conectando edificios concretos por ids. NO siguen las calles — las calles son el esqueleto físico del barrio; los cables son relaciones lógicas.
- **Edge cases**:
  - Proyecto sin VPS → plaza central vacía con cartel CSS2D "sin ayuntamiento" en el centro.
  - Proyecto sin servicios → cartel central "Ciudad vacía" + botón "← Volver al mundo" (igual que F4).
- **Side panel, hover, click componente, mock metrics**: comportamiento idéntico a F4. Cero cambio.
- **Drag en interior**: sigue desactivado (F6 lo abrirá).
- **HUD**, **Esc encadenado**, **navegación**: idénticos a F4.

### Lo que NO entra en F5

- Animaciones (luces, partículas, tráfico animado, LEDs parpadeantes): NO. Eye-candy → F7.
- Drag-to-rearrange en interior: NO. Schema preparado para F6.
- Sonidos / audio: NO.
- Modelos 3D externos (GLTF, OBJ): NO. Todo composición de primitivas.
- Sub-barrios: NO. Cada barrio es plano (sin sub-zonas).
- Búsqueda de edificios: NO.
- Persistencia de cámara: NO.

## Sección 2 — Recetas de edificios

Cada kind tiene una composición específica de primitivas Three.js. Cero assets externos. Las recetas son **datos declarativos** interpretados por un loop, NO 8 funciones distintas.

### Catálogo

| Kind | Edificio | Composición | Altura aprox |
|---|---|---|---|
| `vps` | **Ayuntamiento** | Base `BoxGeometry(3, 1.5, 3)` gris + tejado a dos aguas `ConeGeometry(2.2, 0.8, 4)` gris oscuro + torre central `CylinderGeometry(0.6, 0.6, 1.5)` gris claro + cúpula `SphereGeometry(0.7, 8, 8, 0, π)` dorada | ~3.8 |
| `n8n` | **Torre de oficinas** | Torre `BoxGeometry(1.5, 4, 1.5)` morado + tejado plano `BoxGeometry(1.6, 0.1, 1.6)` oscuro + 3 franjas de ventanas claras `BoxGeometry(0.05, 3.5, 0.05)` en 3 caras | ~4.5 |
| `docker` | **Almacén con contenedores** | Base `BoxGeometry(3, 1, 2)` azul + 2-3 contenedores `BoxGeometry(0.6, 0.6, 0.6)` apilados encima en colores variados (azul/rojo/amarillo) | ~2.2 |
| `chatwoot` | **Torre de comunicaciones** | Base `CylinderGeometry(0.5, 0.7, 3)` naranja + antena `CylinderGeometry(0.05, 0.05, 1)` gris + LED rojo `SphereGeometry(0.1, 8, 8)` arriba | ~4 |
| `postgres` | **Biblioteca neoclásica** | Cuerpo `BoxGeometry(2.5, 1.8, 1.5)` azul oscuro + 4 columnas `CylinderGeometry(0.15, 0.15, 1.8)` blancas + tejado plano `BoxGeometry(2.7, 0.2, 1.7)` + escalera frontal 2 escalones `BoxGeometry(2.2, 0.15, 0.4)` | ~2.5 |
| `github` | **Nave con cúpula** | Cuerpo `BoxGeometry(2.5, 1.5, 2)` blanco + tejado curvo `SphereGeometry(1.4, 12, 6, 0, 2π, 0, π/2)` blanco + entrada `BoxGeometry(0.6, 1.1, 0.1)` oscura frontal | ~2.5 |
| `linear` | **Prisma moderno** | Cuerpo `CylinderGeometry(1.0, 1.0, 2.5, 5)` indigo (cilindro pentagonal) + tejado plano `CircleGeometry(1.05, 5)` oscuro | ~2.5 |
| `custom` | **Casa genérica** | Base `BoxGeometry(1.5, 1.5, 1.5)` gris muted + tejado a dos aguas `ConeGeometry(1.2, 1, 4)` gris oscuro | ~2.5 |

### Estructura `BUILDING_RECIPES`

Cada receta es un array de "piezas". Cada pieza tiene: `geo` (tipo de geometría + parámetros), `color`, `y` (altura del centro de la pieza), opcionalmente `x`/`z` (offset horizontal local) y `rotY` (rotación).

```javascript
const BUILDING_RECIPES = {
  vps: [
    { geo: ["box", 3, 1.5, 3], color: 0x8b949e, y: 0.75 },                                  // base
    { geo: ["cone", 2.2, 0.8, 4], color: 0x5c6470, y: 1.9 },                                // tejado
    { geo: ["cyl", 0.6, 0.6, 1.5], color: 0xa1a8b3, y: 2.75 },                              // torre
    { geo: ["spherehalf", 0.7, 8, 8], color: 0xd4a017, y: 3.5 },                            // cúpula
  ],
  n8n: [ ... ],
  // etc.
};

function buildBuilding(kind) {
  const recipe = BUILDING_RECIPES[kind] || BUILDING_RECIPES.custom;
  const group = new THREE.Group();
  for (const p of recipe) {
    const geo = buildGeo(p.geo);
    const mat = new THREE.MeshStandardMaterial({ color: p.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x || 0, p.y, p.z || 0);
    if (p.rotY) mesh.rotation.y = p.rotY;
    group.add(mesh);
  }
  return group;
}

function buildGeo(spec) {
  const [type, ...args] = spec;
  if (type === "box")        return new THREE.BoxGeometry(...args);
  if (type === "cone")       return new THREE.ConeGeometry(...args);
  if (type === "cyl")        return new THREE.CylinderGeometry(...args);
  if (type === "sphere")     return new THREE.SphereGeometry(...args);
  if (type === "spherehalf") return new THREE.SphereGeometry(args[0], args[1], args[2], 0, Math.PI);
  if (type === "circle")     return new THREE.CircleGeometry(...args);
  throw new Error(`Unknown geo type: ${type}`);
}
```

Añadir/modificar un kind = **~5-10 líneas de datos**, no código nuevo.

### Performance

- 8 kinds × ~5 piezas promedio = ~40 primitivas por receta.
- Proyecto típico con 10 servicios visibles en interior ≈ ~400 meshes.
- Sin LOD, sin InstancedMesh, sin frustum culling adicional. WebGL maneja esto trivialmente en desktop. Mobile no se optimiza activamente en F5.
- World cluster: 5 edificios mini por ciudad × N ciudades × ~5 primitivas mini cada = ~25·N meshes. Para 50 ciudades = 1250 meshes en world. Aún trivial.

## Sección 3 — Schema + cambios backend

### Schema `.panel.json` bumpea a `version: 3`

Añade un solo campo opcional por servicio:

```json
{
  "version": 3,
  "world_position": { "x": 0, "z": 0 },
  "services": [
    {
      "id": "vps-7f2a",
      "kind": "vps",
      "name": "VPS principal",
      "config": { "host": "1.2.3.4" },
      "position": { "x": 0, "z": 0 },
      "interior_position": { "x": 0, "z": 0 }
    }
  ],
  "connections": [ ... ]
}
```

### Reglas

- **`interior_position`** es opcional. Si falta, el layout star auto-asigna posición. Si presente, se respeta (para F6 cuando se añada drag dentro del interior).
- Validación backend: `{x, z}` finitos en rango `[-50, 50]` (más acotado que `position`/`world_position` porque el interior es más pequeño).
- Backwards-compat: `.panel.json` v1/v2 sin `interior_position` cargan sin error; defaults aplicados por `load_project_meta()`.
- En F5 NO se persisten posiciones interior (porque no hay drag); el campo queda preparado.

### Cambios `backend/server.py` (~+10 líneas)

- `validate_meta_payload()`: añadir bloque equivalente a `position`/`world_position` para `interior_position` (validar `{x,z}` finitos en `[-50,50]`).
- `load_project_meta()`: si falta `interior_position` en un service, asignar `{x:0, z:0}`.
- Output normalizado de `validate_meta_payload()` emite `version: 3`.

## Sección 4 — Arquitectura técnica frontend

### Sin archivos nuevos

Toda la F5 cabe en:
- `frontend/map3d.js` (~+400 líneas).
- `frontend/map3d.css` (~+10 líneas).
- `backend/server.py` (~+10 líneas).

### Constantes nuevas en `map3d.js`

```javascript
const BUILDING_RECIPES = { vps: [...], n8n: [...], docker: [...], chatwoot: [...],
                            postgres: [...], github: [...], linear: [...], custom: [...] };
const STREET_LENGTH       = 8;        // longitud de cada calle radial
const STREET_RADIUS_START = 6;        // donde empieza la calle (fuera de la plaza)
const STREET_WIDTH        = 1.2;
const PLAZA_RADIUS        = 3.5;      // radio donde se colocan VPSs adicionales
const CITY_CLUSTER_CENTRAL_SCALE = 0.5;
const CITY_CLUSTER_SECONDARY_SCALE = 0.4;
const CITY_CLUSTER_MAX = 5;
```

### Funciones nuevas

- `buildGeo(spec)` — helper que crea geometrías Three.js desde array spec (Sección 2).
- `buildBuilding(kind)` — devuelve `THREE.Group` con la composición de primitivas del kind.
- `buildCityCluster(services)` — devuelve `THREE.Group` con cluster mini para world view (1 central + hasta 4 secundarios + badge "+N más").
- `firstVps(services)` — helper que devuelve el primer servicio con `kind === "vps"` por orden de id, o null.
- `buildStreet(angle, label)` — devuelve `THREE.Group` con calle (rect asfalto + dashed) + label CSS2D, rotada para apuntar al ángulo dado.

### Funciones modificadas

- **`buildInterior(client, project)`** (reescritura completa):
  - Plaza central: ayuntamiento + VPSs adicionales / dockers alrededor.
  - Barrios NO infraestructura: una calle radial por cada uno, edificios alineados a los lados.
  - Cables intra-ciudad: mantener como F4 (entre edificios por id).
  - Empty state: cartel "Ciudad vacía".
  - Edge "sin VPS": cartel "sin ayuntamiento" en plaza.
- **`buildCity(client, project, meta, worldPos)`** (modificación):
  - En vez de iterar `services` y crear primitivas con `buildZone`, llama a `buildCityCluster(services)` y añade el cluster al cityGroup.
  - Mantener footprint + label + cables como hoy.
- **`buildZone(...)`** existente queda como **deprecated/fallback**: no se usa por defecto en F5 pero se mantiene en código por si algún caller futuro lo necesita.

### Compatibilidad

- Interacciones del mouse (hover, click, drag, fly-to, side panels, Esc, HUD): cero cambios. El raycaster sigue picando `userData.type === "zone"` y `"city-footprint"` — los edificios temáticos del cluster mini y del interior llevan los mismos `userData` que las primitivas anteriores, así que el picking funciona idéntico.
- Mock metrics, side panel enriquecido, ticker, refresh: cero cambios desde F4.

## Sección 5 — Verificación, archivos y caveats

### Checklist manual (debe pasar antes de declarar F5 completa)

**World view (mini-ciudades)**
- [ ] Cada ciudad se ve como cluster compacto sobre footprint (no como primitivas en círculo).
- [ ] Edificio central = ayuntamiento (VPS) si el proyecto tiene VPS; otro kind si no.
- [ ] Hasta 5 edificios mini visibles; > 5 → badge "+N más" CSS2D sobre el cluster.
- [ ] Hover, click footprint, click edificio individual = comportamiento idéntico a F3/F4.
- [ ] Drag con Edit Mode: drag de la ciudad mueve el cluster entero.

**Interior — star topology**
- [ ] Plaza central con ayuntamiento (VPS) en (0,0,0).
- [ ] Si hay varios VPSs / dockers, alrededor del ayuntamiento (radio 3.5).
- [ ] Por cada barrio NO infraestructura, una calle radial parte de la plaza.
- [ ] Calles renderizadas como rectángulos planos asfalto + líneas blancas dashed.
- [ ] Edificios del barrio alineados a ambos lados de su calle, alternando, espaciados.
- [ ] Cables intra-ciudad siguen conectando edificios concretos (no las calles).
- [ ] Proyecto sin VPS → cartel "sin ayuntamiento" en la plaza.
- [ ] Empty state (proyecto sin servicios): cartel "Ciudad vacía".

**Edificios temáticos**
- [ ] Cada kind se reconoce visualmente: VPS=ayuntamiento con cúpula, n8n=torre franjas, postgres=biblioteca columnas, chatwoot=torre+antena, docker=almacén+contenedores, github=nave con cúpula, linear=prisma pentagonal, custom=casa.
- [ ] Recetas declarativas en `BUILDING_RECIPES`. Modificar 1 receta = ~5-10 líneas de datos.

**Schema y persistencia**
- [ ] Schema v3: `interior_position` opcional, validado, defaults aplicados.
- [ ] `.panel.json` v1/v2 cargan sin error (backwards-compat).
- [ ] Payload con `interior_position` fuera de rango → backend 400.

**No regresiones F3/F4**
- [ ] Side panel enriquecido en interior funciona igual.
- [ ] Esc encadenado.
- [ ] HUD adaptado.
- [ ] Drag en interior sigue desactivado (F6 lo abrirá).
- [ ] Pestaña Proyectos / Monitorización / Linear: idénticas.
- [ ] Tras CRUD en pestaña Proyectos → world se refresca.

### Archivos a tocar

**Modificar:**
- `frontend/map3d.js` (~+400 líneas).
- `frontend/map3d.css` (~+10 líneas: estilo `street-label`, `cluster-more-badge`).
- `backend/server.py` (~+10 líneas: schema v3).

**Crear:**
- `docs/superpowers/specs/2026-06-30-fase5-edificios-tematicos-design.md` (este spec).
- `docs/superpowers/plans/2026-06-30-fase5-edificios-tematicos-plan.md` (tras aprobación, vía writing-plans).

### Caveats explícitos (lo que NO entra en F5)

1. **Animaciones** (luces, partículas, tráfico, LEDs parpadeantes): NO.
2. **Drag en interior**: NO. Schema preparado; UI en F6.
3. **Sonidos / audio**: NO.
4. **Modelos 3D externos** (GLTF, OBJ): NO.
5. **Mobile optimization**: parcial; funciona pero perf no garantizada.
6. **Cluster mini en world muestra hasta 5 edificios**: resto solo se ve al entrar.
7. **Sub-barrios** (p. ej. "base de datos" → primarias vs réplicas): NO.
8. **Búsqueda de edificios**: NO.
9. **Persistencia de cámara**: NO.

### Fases siguientes apuntadas

- **F6**: drag-to-rearrange edificios dentro del interior + UI para rotar calles radiales.
- **F7**: animaciones (luces parpadeantes según mock metrics, partículas en cables, LEDs en antenas).
- **F8** (cuando F2 esté lista): mock metrics → datos reales del monitor sin tocar la UI.
