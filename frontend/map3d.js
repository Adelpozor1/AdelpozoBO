// frontend/map3d.js — Fase 3: mapa 3D isométrico como home del panel.
// Se carga lazy (dinámicamente) la primera vez que el usuario entra a la
// pestaña "Mapa". Estilos en map3d.css; HTML overlays en index.html (#map-home).

import * as THREE from "/static/vendor/three.module.js";
import { CSS2DRenderer, CSS2DObject } from "/static/vendor/CSS2DRenderer.js";

// --- Constantes visuales ---------------------------------------------------
const ZONE_PRIMITIVES = {
  vps:      () => new THREE.BoxGeometry(1.5, 1.5, 1.5),
  n8n:      () => new THREE.CylinderGeometry(0.8, 0.8, 1.5, 16),
  docker:   () => new THREE.BoxGeometry(1.2, 1.2, 1.2),
  chatwoot: () => new THREE.ConeGeometry(0.9, 1.8, 16),
  postgres: () => new THREE.CylinderGeometry(0.9, 0.9, 1.5, 24),
  github:   () => new THREE.OctahedronGeometry(0.9, 0),
  linear:   () => new THREE.TetrahedronGeometry(1.0, 0),
  custom:   () => new THREE.DodecahedronGeometry(0.9, 0),
};

const ZONE_COLORS = {
  vps:      0x8b949e,
  n8n:      0xa371f7,
  docker:   0x2496ed,
  chatwoot: 0xf48120,
  postgres: 0x336791,
  github:   0xe6edf3,
  linear:   0x5e6ad2,
  custom:   0x6e7681,
};

const CITY_FOOTPRINT_SIZE = 10;
const CITY_GRID_SPACING   = 12;
const ZONE_RADIUS         = 3.0;
const ZONE_Y              = 1.0;     // altura desde el footprint
const FRUSTUM_MIN         = 5;
const FRUSTUM_MAX         = 200;
const FRUSTUM_DEFAULT     = 80;
const FLY_TO_FRUSTUM      = 30;
const FLY_TO_MS           = 600;

// --- Estado del módulo (single-instance) ----------------------------------
let scene, camera, renderer, cssRenderer;
let worldGroup;
let container, canvasWrap;
let initialized = false;

// Render dirty-flag
let dirty = true;
function markDirty() { dirty = true; }

// --- API pública ----------------------------------------------------------
export function initMap3D(containerEl) {
  if (initialized) { onResize(); markDirty(); return; }
  container = containerEl;
  canvasWrap = container.querySelector("#mapCanvasWrap");

  // Escena
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  // Cámara ortográfica isométrica
  const aspect = canvasWrap.clientWidth / canvasWrap.clientHeight;
  camera = new THREE.OrthographicCamera(
    -FRUSTUM_DEFAULT * aspect / 2,  FRUSTUM_DEFAULT * aspect / 2,
     FRUSTUM_DEFAULT / 2,          -FRUSTUM_DEFAULT / 2,
     0.1, 1000
  );
  camera.position.set(50, 50, 50);
  camera.lookAt(0, 0, 0);
  camera.userData.frustumSize = FRUSTUM_DEFAULT;

  // Renderer WebGL
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
  canvasWrap.appendChild(renderer.domElement);

  // Renderer CSS2D para etiquetas
  cssRenderer = new CSS2DRenderer();
  cssRenderer.setSize(canvasWrap.clientWidth, canvasWrap.clientHeight);
  cssRenderer.domElement.style.position = "absolute";
  cssRenderer.domElement.style.inset = "0";
  cssRenderer.domElement.style.pointerEvents = "none";
  canvasWrap.appendChild(cssRenderer.domElement);

  // Luces
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
  dirLight.position.set(60, 100, 40);
  scene.add(dirLight);

  // Ground + grid
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: 0x141b27 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.userData.type = "ground";
  scene.add(ground);

  const grid = new THREE.GridHelper(2000, 200, 0x2a3550, 0x1a2030);
  grid.position.y = 0.01;
  scene.add(grid);

  // Grupo de mundo (todas las ciudades cuelgan de aquí)
  worldGroup = new THREE.Group();
  scene.add(worldGroup);

  // Render loop (dirty-only)
  function animate() {
    requestAnimationFrame(animate);
    if (dirty) {
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
      dirty = false;
    }
  }
  animate();

  // Resize
  window.addEventListener("resize", onResize);

  initialized = true;
  markDirty();
  bindInput();
  bindWorldBtn();
  const ec = container.querySelector("#mapEmptyCreate");
  if (ec) ec.onclick = () => {
    if (typeof window.setSection === "function") window.setSection("dev");
  };
  loadWorld();        // primer fetch del mundo
}

function onResize() {
  if (!canvasWrap) return;
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  const aspect = w / h;
  const fs = camera.userData.frustumSize;
  camera.left   = -fs * aspect / 2;
  camera.right  =  fs * aspect / 2;
  camera.top    =  fs / 2;
  camera.bottom = -fs / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  cssRenderer.setSize(w, h);
  markDirty();
}

// --- Estado de datos ------------------------------------------------------
const cityMap = new Map();   // key "client/project" → { group, footprint, label, zones: Map<id, mesh>, cables: Map<id, line>, projectMeta }
let worldLoaded = false;

export async function loadWorld() {
  try {
    const r = await fetch("/api/world");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    buildWorld(data);
    worldLoaded = true;
    markDirty();
    return data;
  } catch (e) {
    console.error("loadWorld:", e);
    return null;
  }
}

function clearWorld() {
  for (const c of cityMap.values()) {
    worldGroup.remove(c.group);
    disposeGroup(c.group);
  }
  cityMap.clear();
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

function buildWorld(data) {
  clearWorld();
  const all = [];
  for (const cli of data.clients || []) {
    for (const proj of cli.projects || []) {
      all.push({ client: cli.name, project: proj.name, meta: proj.meta || {} });
    }
  }
  // Auto-layout: indices secuenciales en un grid sqrt(N)x sqrt(N) para los
  // proyectos sin world_position propia.
  const cols = Math.max(1, Math.ceil(Math.sqrt(all.length)));
  let autoIndex = 0;
  for (const entry of all) {
    const hasWp = entry.meta.world_position
      && (entry.meta.world_position.x || entry.meta.world_position.z);
    const wp = hasWp ? entry.meta.world_position : autoLayoutCity(autoIndex, cols);
    autoIndex++;
    const cityGroup = buildCity(entry.client, entry.project, entry.meta, wp);
    worldGroup.add(cityGroup);
  }
  // Empty state
  const empty = (data.clients || []).every(c => (c.projects || []).length === 0);
  const overlay = container.querySelector("#mapEmptyState");
  if (overlay) overlay.classList.toggle("hidden", !empty);
}

function autoLayoutCity(index, cols) {
  const row = Math.floor(index / cols);
  const col = index % cols;
  return {
    x: (col - (cols - 1) / 2) * CITY_GRID_SPACING,
    z: (row - 0) * CITY_GRID_SPACING,
  };
}

function autoLayoutZone(index, total) {
  const t = Math.max(total, 3);
  const angle = (2 * Math.PI * index) / t;
  return {
    x: ZONE_RADIUS * Math.cos(angle),
    z: ZONE_RADIUS * Math.sin(angle),
  };
}

function buildCity(client, project, meta, worldPos) {
  const group = new THREE.Group();
  group.userData = { type: "city", client, project, meta };
  group.position.set(worldPos.x, 0, worldPos.z);

  // Footprint
  const footprint = new THREE.Mesh(
    new THREE.BoxGeometry(CITY_FOOTPRINT_SIZE, 0.15, CITY_FOOTPRINT_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x202a3a })
  );
  footprint.position.y = 0.08;
  footprint.userData = { type: "city-footprint", client, project };
  group.add(footprint);

  // Label CSS2D
  const labelDiv = document.createElement("div");
  labelDiv.className = "city-label";
  labelDiv.textContent = `${client} / ${project}`;
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, 2.5, 0);
  group.add(label);

  const services = meta.services || [];
  // Sub-label "ciudad sin zonas" si el proyecto está vacío
  if (services.length === 0) {
    const subDiv = document.createElement("div");
    subDiv.className = "city-sublabel";
    subDiv.textContent = "ciudad sin zonas";
    labelDiv.appendChild(subDiv);
  }

  // Zones
  const zoneMap = new Map();
  services.forEach((svc, idx) => {
    const pos = svc.position && (svc.position.x || svc.position.z)
      ? svc.position
      : autoLayoutZone(idx, services.length);
    const zone = buildZone(svc, pos, client, project);
    zoneMap.set(svc.id, zone);
    group.add(zone);
  });

  // Cables
  const cableMap = new Map();
  for (const conn of meta.connections || []) {
    const a = zoneMap.get(conn.from);
    const b = zoneMap.get(conn.to);
    if (!a || !b) continue;
    const cable = buildCable(conn, a, b);
    cableMap.set(conn.id, cable);
    group.add(cable);
  }

  cityMap.set(`${client}/${project}`, {
    group, footprint, label, zones: zoneMap, cables: cableMap, projectMeta: meta,
  });
  return group;
}

function buildZone(svc, pos, client, project) {
  const geo = (ZONE_PRIMITIVES[svc.kind] || ZONE_PRIMITIVES.custom)();
  const mat = new THREE.MeshStandardMaterial({ color: ZONE_COLORS[svc.kind] || ZONE_COLORS.custom });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { type: "zone", service: svc, client, project };
  mesh.position.set(pos.x, ZONE_Y, pos.z);
  return mesh;
}

function buildCable(conn, fromMesh, toMesh) {
  const points = cablePoints(fromMesh.position, toMesh.position);
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x5a8ad0, linewidth: 2 });
  const line = new THREE.Line(geo, mat);
  line.userData = { type: "cable", connection: conn, fromId: conn.from, toId: conn.to };
  return line;
}

function cablePoints(p0, p1) {
  // Línea recta a ras de zona (Y ligeramente por debajo de ZONE_Y para no atravesar mesh)
  const y = ZONE_Y * 0.8;
  return [
    new THREE.Vector3(p0.x, y, p0.z),
    new THREE.Vector3(p1.x, y, p1.z),
  ];
}

// --- Input: pan + zoom + raycaster ----------------------------------------
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
let lastHover = null;       // último objeto bajo el ratón (zone/city-footprint/cable)

let isPanning = false;
let panStart = null;        // {camX, camZ, mouseX, mouseY}

function ndcFromEvent(ev) {
  const rect = canvasWrap.getBoundingClientRect();
  mouseNDC.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
  mouseNDC.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1;
}

function raycast() {
  raycaster.setFromCamera(mouseNDC, camera);
  // recursive=true para entrar en cityGroups y pillar zones/footprints/cables
  return raycaster.intersectObject(worldGroup, true);
}

function pickInteractive(hits) {
  // Devuelve el primer hit que tiene userData.type interesante
  for (const h of hits) {
    let obj = h.object;
    while (obj) {
      const t = obj.userData && obj.userData.type;
      if (t === "zone" || t === "city-footprint" || t === "cable") return obj;
      obj = obj.parent;
    }
  }
  return null;
}

let onMouseDown = function(ev) {
  if (ev.button !== 0) return;
  ndcFromEvent(ev);
  // Pan: solo si NO clickas sobre nada interactivo
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked) {
    // No-op aquí; Task 6 lo extiende para drag en Edit Mode.
    return;
  }
  isPanning = true;
  panStart = { camX: camera.position.x, camZ: camera.position.z, mx: ev.clientX, my: ev.clientY };
};

let onMouseMove = function(ev) {
  ndcFromEvent(ev);
  if (isPanning && panStart) {
    // pan: convertir delta de pixels en delta de mundo según frustumSize
    const fs = camera.userData.frustumSize;
    const rect = canvasWrap.getBoundingClientRect();
    const worldPerPxX = fs * (rect.width / rect.height) / rect.width;
    const worldPerPxY = fs / rect.height;
    const dx = (ev.clientX - panStart.mx) * worldPerPxX;
    const dy = (ev.clientY - panStart.my) * worldPerPxY;
    // Como la cámara mira con yaw=45°, traducimos a coords mundo
    camera.position.x = panStart.camX - dx * Math.cos(Math.PI / 4) - dy * Math.sin(Math.PI / 4);
    camera.position.z = panStart.camZ + dx * Math.sin(Math.PI / 4) - dy * Math.cos(Math.PI / 4);
    markDirty();
    return;
  }
  // Hover (sin drag): raycaster
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked !== lastHover) {
    lastHover = picked;
    onHoverChange(picked, ev);
  } else if (picked) {
    onHoverMove(ev);
  }
};

let onMouseUp = function(ev) {
  if (ev.button !== 0) return;
  isPanning = false;
  panStart = null;
};

function onWheel(ev) {
  ev.preventDefault();
  // zoom centrado en el cursor
  const fs = camera.userData.frustumSize;
  const factor = ev.deltaY > 0 ? 1.1 : 1 / 1.1;
  const newFs = Math.max(FRUSTUM_MIN, Math.min(FRUSTUM_MAX, fs * factor));
  if (newFs === fs) return;

  // Punto del mundo bajo el cursor antes del zoom
  ndcFromEvent(ev);
  const beforePoint = unprojectToGround(mouseNDC, camera);

  // Aplicar zoom
  setFrustum(newFs);

  // Punto del mundo bajo el cursor después
  const afterPoint = unprojectToGround(mouseNDC, camera);

  // Ajustar la cámara para que el punto bajo el cursor no se mueva
  camera.position.x += beforePoint.x - afterPoint.x;
  camera.position.z += beforePoint.z - afterPoint.z;
  markDirty();
}

function setFrustum(fs) {
  camera.userData.frustumSize = fs;
  const aspect = canvasWrap.clientWidth / canvasWrap.clientHeight;
  camera.left   = -fs * aspect / 2;
  camera.right  =  fs * aspect / 2;
  camera.top    =  fs / 2;
  camera.bottom = -fs / 2;
  camera.updateProjectionMatrix();
}

function unprojectToGround(ndc, cam) {
  // Devuelve el punto en Y=0 al que apunta este NDC
  const v = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(cam);
  const dir = new THREE.Vector3().subVectors(v, cam.position).normalize();
  // Si la cámara es ortográfica, el ray empieza en v y va en dir = lookAt direction
  const origin = cam.isOrthographicCamera ? v.clone() : cam.position.clone();
  const t = -origin.y / dir.y;
  return new THREE.Vector3(origin.x + t * dir.x, 0, origin.z + t * dir.z);
}

// --- Hover tooltip (Task 6) ----------------------------------------------
let tooltipEl = null;
let tooltipTimer = null;

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = container.querySelector("#mapTooltip");
  return tooltipEl;
}

function tooltipFor(obj) {
  if (!obj) return "";
  const ud = obj.userData || {};
  if (ud.type === "zone") {
    const s = ud.service || {};
    return `${s.kind || "?"} · ${s.name || ""}`;
  }
  if (ud.type === "city-footprint") {
    return `${ud.client} / ${ud.project}`;
  }
  if (ud.type === "cable") {
    const c = ud.connection || {};
    return c.label || "";
  }
  return "";
}

function onHoverChange(obj, ev) {
  ensureTooltip();
  if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
  const text = tooltipFor(obj);
  if (!text) {
    tooltipEl.classList.add("hidden");
    canvasWrap.style.cursor = "default";
    return;
  }
  // delay 200ms antes de mostrar
  tooltipTimer = setTimeout(() => {
    tooltipEl.textContent = text;
    tooltipEl.classList.remove("hidden");
    positionTooltip(ev);
  }, 200);
  // cursor según tipo
  if (obj.userData.type === "zone" || obj.userData.type === "city-footprint") {
    canvasWrap.style.cursor = "pointer";
  } else {
    canvasWrap.style.cursor = "default";
  }
}

function onHoverMove(ev) {
  if (!tooltipEl || tooltipEl.classList.contains("hidden")) return;
  positionTooltip(ev);
}

function positionTooltip(ev) {
  const rect = container.getBoundingClientRect();
  tooltipEl.style.left = (ev.clientX - rect.left + 12) + "px";
  tooltipEl.style.top  = (ev.clientY - rect.top  + 12) + "px";
}

function bindInput() {
  const el = canvasWrap;
  el.addEventListener("mousedown", (e) => onMouseDown(e));
  window.addEventListener("mousemove", (e) => onMouseMove(e));
  window.addEventListener("mouseup", (e) => onMouseUp(e));
  el.addEventListener("wheel", (e) => onWheel(e), { passive: false });
  bindHud();
}

// --- Edit Mode + drag manual (Task 7) -------------------------------------
let editMode = false;
let draggingObj = null;       // mesh siendo arrastrada (zone o cityFootprint)
let dragStart = null;         // { x0, z0, pickedAt:{x,z} }
let dragMoved = false;

function setEditMode(on) {
  editMode = !!on;
  const btn = container.querySelector("#mapEditToggle");
  if (btn) {
    btn.textContent = editMode ? "✏️ Modo edición" : "🔒 Layout fijo";
    btn.classList.toggle("active", editMode);
  }
}

function bindHud() {
  const btn = container.querySelector("#mapEditToggle");
  if (btn) btn.onclick = () => setEditMode(!editMode);
}

// Extender onMouseDown para drag de objetos en Edit Mode.
const _onMouseDown_orig = onMouseDown;
onMouseDown = function(ev) {
  if (ev.button !== 0) return;
  ndcFromEvent(ev);
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked && editMode && sceneMode === "world" && (picked.userData.type === "zone" || picked.userData.type === "city-footprint")) {
    // start drag
    const ground = unprojectToGround(mouseNDC, camera);
    if (picked.userData.type === "zone") {
      draggingObj = picked;
      dragStart = { x0: picked.position.x, z0: picked.position.z, pickedAt: ground };
    } else {
      // city-footprint: arrastramos el cityGroup entero
      draggingObj = picked.parent;     // el cityGroup
      dragStart = { x0: draggingObj.position.x, z0: draggingObj.position.z, pickedAt: ground };
    }
    dragMoved = false;
    return;
  }
  if (picked) return;   // click sobre algo interactivo SIN Edit Mode → ignora (click handlers en Task 8)
  // Pan fallback
  isPanning = true;
  panStart = { camX: camera.position.x, camZ: camera.position.z, mx: ev.clientX, my: ev.clientY };
};

// Extender onMouseMove para mover el objeto arrastrado
const _onMouseMove_orig = onMouseMove;
onMouseMove = function(ev) {
  ndcFromEvent(ev);
  if (draggingObj && dragStart) {
    const ground = unprojectToGround(mouseNDC, camera);
    const dx = ground.x - dragStart.pickedAt.x;
    const dz = ground.z - dragStart.pickedAt.z;
    if (Math.abs(dx) + Math.abs(dz) > 0.05) dragMoved = true;
    if (draggingObj.userData.type === "zone") {
      draggingObj.position.x = dragStart.x0 + dx;
      draggingObj.position.z = dragStart.z0 + dz;
      // Actualizar cables que tocan esta zona
      updateCablesForZone(draggingObj);
    } else {
      // cityGroup
      draggingObj.position.x = dragStart.x0 + dx;
      draggingObj.position.z = dragStart.z0 + dz;
    }
    markDirty();
    return;
  }
  // Pan
  if (isPanning && panStart) {
    const fs = camera.userData.frustumSize;
    const rect = canvasWrap.getBoundingClientRect();
    const worldPerPxX = fs * (rect.width / rect.height) / rect.width;
    const worldPerPxY = fs / rect.height;
    const dx2 = (ev.clientX - panStart.mx) * worldPerPxX;
    const dy2 = (ev.clientY - panStart.my) * worldPerPxY;
    camera.position.x = panStart.camX - dx2 * Math.cos(Math.PI / 4) - dy2 * Math.sin(Math.PI / 4);
    camera.position.z = panStart.camZ + dx2 * Math.sin(Math.PI / 4) - dy2 * Math.cos(Math.PI / 4);
    markDirty();
    return;
  }
  // Hover (sin drag/pan): raycaster
  const hits = raycast();
  const picked = pickInteractive(hits);
  if (picked !== lastHover) {
    lastHover = picked;
    onHoverChange(picked, ev);
  } else if (picked) {
    onHoverMove(ev);
  }
};

// Extender onMouseUp para confirmar drag y persistir
const _onMouseUp_orig = onMouseUp;
onMouseUp = function(ev) {
  if (ev.button !== 0) return;
  if (draggingObj && dragMoved) {
    persistDragged(draggingObj);
    showSavePulse(ev);
  }
  draggingObj = null;
  dragStart = null;
  dragMoved = false;
  isPanning = false;
  panStart = null;
};

function updateCablesForZone(zoneMesh) {
  const cityGroup = zoneMesh.parent;
  cityGroup.traverse(obj => {
    if (!obj.userData || obj.userData.type !== "cable") return;
    const fromId = obj.userData.fromId;
    const toId = obj.userData.toId;
    const cityKey = cityKeyOf(cityGroup);
    const cityRec = cityMap.get(cityKey);
    if (!cityRec) return;
    const a = cityRec.zones.get(fromId);
    const b = cityRec.zones.get(toId);
    if (!a || !b) return;
    const points = cablePoints(a.position, b.position);
    obj.geometry.setFromPoints(points);
    obj.geometry.attributes.position.needsUpdate = true;
  });
}

function cityKeyOf(cityGroup) {
  const ud = cityGroup.userData || {};
  return `${ud.client}/${ud.project}`;
}

const _persistTimers = new Map();
function persistDragged(obj) {
  // Determina qué proyecto y dispara POST debounced 300ms
  let cityGroup;
  if (obj.userData.type === "zone") {
    cityGroup = obj.parent;
  } else {
    cityGroup = obj;   // ya es el cityGroup
  }
  const key = cityKeyOf(cityGroup);
  const cityRec = cityMap.get(key);
  if (!cityRec) return;
  // Actualizar el meta en memoria con las posiciones actuales
  const meta = cityRec.projectMeta;
  meta.world_position = { x: cityGroup.position.x, z: cityGroup.position.z };
  for (const svc of meta.services || []) {
    const m = cityRec.zones.get(svc.id);
    if (m) svc.position = { x: m.position.x, z: m.position.z };
  }
  // Debounce
  if (_persistTimers.has(key)) clearTimeout(_persistTimers.get(key));
  _persistTimers.set(key, setTimeout(() => doPersist(cityGroup.userData.client, cityGroup.userData.project, meta), 300));
}

async function doPersist(client, project, meta) {
  try {
    const r = await fetch("/api/projects/meta", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client, project,
        world_position: meta.world_position,
        services: meta.services,
        connections: meta.connections,
      }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    const data = await r.json();
    // Actualizar ids (deberían ser los mismos) y posiciones desde la respuesta
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) {
      rec.projectMeta.services = data.services || rec.projectMeta.services;
      rec.projectMeta.connections = data.connections || rec.projectMeta.connections;
      rec.projectMeta.world_position = data.world_position || rec.projectMeta.world_position;
    }
  } catch (e) {
    alert("No se pudo guardar la posición: " + e.message);
  }
}

function showSavePulse(ev) {
  const rect = container.getBoundingClientRect();
  const el = document.createElement("div");
  el.className = "save-pulse";
  el.textContent = "✓ guardado";
  el.style.left = (ev.clientX - rect.left + 10) + "px";
  el.style.top  = (ev.clientY - rect.top  - 10) + "px";
  container.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

// --- Click handlers + fly-to (Task 8) -------------------------------------
let mouseDownAt = null;   // {x, y} para distinguir click de drag
const CLICK_THRESHOLD_PX = 5;

// Re-extender onMouseDown para registrar el punto inicial
const _onMouseDown_v3 = onMouseDown;
onMouseDown = function(ev) {
  if (ev.button === 0) mouseDownAt = { x: ev.clientX, y: ev.clientY };
  _onMouseDown_v3(ev);
};

// Re-extender onMouseUp: si NO se movió >5px y el destino del mousedown era un objeto interactivo, es un click
const _onMouseUp_v3 = onMouseUp;
onMouseUp = function(ev) {
  if (ev.button === 0 && mouseDownAt) {
    const dist = Math.hypot(ev.clientX - mouseDownAt.x, ev.clientY - mouseDownAt.y);
    if (dist < CLICK_THRESHOLD_PX) {
      // Click puro (sin drag): raycast y dispatcha
      ndcFromEvent(ev);
      const hits = raycast();
      const picked = pickInteractive(hits);
      if (picked) handleClick(picked, ev);
      else handleGroundClick(ev);
    }
  }
  mouseDownAt = null;
  _onMouseUp_v3(ev);
};

function handleClick(obj, ev) {
  const t = obj.userData.type;
  if (t === "zone") {
    openZonePanel(obj);
  } else if (t === "city-footprint") {
    // Si el side panel está cerrado: fly-to. Si está abierto: cierra primero.
    if (!sidePanelOpen) flyToCity(obj.parent);
    openCityPanel(obj.parent);
  }
}

function handleGroundClick(ev) {
  // Click en suelo → cierra side panel
  closeSidePanel();
}

// Animación fly-to (centra la cámara sobre una ciudad)
let flyAnim = null;
function flyToCity(cityGroup) {
  cancelFly();
  const targetX = cityGroup.position.x;
  const targetZ = cityGroup.position.z;
  const startX = camera.position.x, startZ = camera.position.z;
  const startFs = camera.userData.frustumSize;
  const endFs = FLY_TO_FRUSTUM;
  // Posición destino de la cámara (para que mire al centro de la ciudad)
  const offsetX = 50, offsetZ = 50;   // mismo offset que el initial setup
  const endX = targetX + offsetX, endZ = targetZ + offsetZ;
  const t0 = performance.now();
  const step = function(now) {
    const t = Math.min(1, (now - t0) / FLY_TO_MS);
    const k = easeInOut(t);
    camera.position.x = startX + (endX - startX) * k;
    camera.position.z = startZ + (endZ - startZ) * k;
    setFrustum(startFs + (endFs - startFs) * k);
    markDirty();
    if (t < 1) flyAnim = requestAnimationFrame(step);
    else flyAnim = null;
  };
  flyAnim = requestAnimationFrame(step);
  // Mostrar botón "Ver mundo"
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.classList.remove("hidden");
}

function flyToWorld() {
  cancelFly();
  const startX = camera.position.x, startZ = camera.position.z;
  const startFs = camera.userData.frustumSize;
  const endFs = FRUSTUM_DEFAULT;
  const endX = 50, endZ = 50;
  const t0 = performance.now();
  const step = function(now) {
    const t = Math.min(1, (now - t0) / FLY_TO_MS);
    const k = easeInOut(t);
    camera.position.x = startX + (endX - startX) * k;
    camera.position.z = startZ + (endZ - startZ) * k;
    setFrustum(startFs + (endFs - startFs) * k);
    markDirty();
    if (t < 1) flyAnim = requestAnimationFrame(step);
    else flyAnim = null;
  };
  flyAnim = requestAnimationFrame(step);
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.classList.add("hidden");
}

function cancelFly() {
  if (flyAnim && typeof flyAnim === "number") cancelAnimationFrame(flyAnim);
  flyAnim = null;
}

function easeInOut(t) { return t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }

// HUD: botón "Ver mundo" (Fase 3) y "← Volver al mundo" (Fase 4)
function bindWorldBtn() {
  const wb = container.querySelector("#mapWorldBtn");
  if (wb) wb.onclick = () => flyToWorld();
  const bb = container.querySelector("#mapBackBtn");
  if (bb) bb.onclick = () => { if (typeof exitCity === "function") exitCity(); };
}

// --- Side panels (Task 9) -------------------------------------------------
let sidePanelOpen = false;
let sidePanelContext = null;     // { type: "zone" | "city", ... }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function openZonePanel(zoneMesh) {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  const svc = zoneMesh.userData.service;
  const client = zoneMesh.userData.client;
  const project = zoneMesh.userData.project;
  const inInterior = !!zoneMesh.userData.inInterior;
  const meta = (cityMap.get(`${client}/${project}`) || {}).projectMeta || {};
  const connections = (meta.connections || []).filter(c => c.from === svc.id || c.to === svc.id);
  const nameOf = id => {
    const m = (meta.services || []).find(x => x.id === id);
    return m ? m.name : id;
  };

  // Bloques condicionales: solo en interior, mostrar Estado enriquecido + Métricas
  let estadoBlock = "";
  let metricasBlock = "";
  if (inInterior) {
    const m = mockMetrics.get(svc.id) || { status: "ok", cpu: 0, ram: 0, disk: 0, uptimeSeconds: 0 };
    const cpuTxt = Math.round(m.cpu) + "%";
    const ramTxt = Math.round(m.ram) + "%";
    const diskTxt = Math.round(m.disk) + "%";
    const upTxt = humanUptime(m.uptimeSeconds);
    estadoBlock = `
    <div class="sp-block">
      <h4>Estado (simulado)</h4>
      <div class="sp-status-row">
        <span class="status-dot status-${m.status}"></span>
        <span>${escapeHtml(statusText(m.status))}</span>
      </div>
      <div class="sp-status-mock-note">datos simulados · conectar Fase 2 para datos reales</div>
    </div>`;
    metricasBlock = `
    <div class="sp-block">
      <h4>Métricas (simuladas)</h4>
      <div class="metric"><span>CPU</span><span data-metric="cpu">${cpuTxt}</span>
        <div class="bar"><div data-metric-bar="cpu" style="width:${Math.round(m.cpu)}%"></div></div></div>
      <div class="metric"><span>RAM</span><span data-metric="ram">${ramTxt}</span>
        <div class="bar"><div data-metric-bar="ram" style="width:${Math.round(m.ram)}%"></div></div></div>
      <div class="metric"><span>Disk</span><span data-metric="disk">${diskTxt}</span>
        <div class="bar"><div data-metric-bar="disk" style="width:${Math.round(m.disk)}%"></div></div></div>
      <div class="metric-uptime">Uptime: <span data-metric="uptime">${escapeHtml(upTxt)}</span></div>
    </div>`;
  } else {
    estadoBlock = `
    <div class="sp-block">
      <h4>Estado</h4>
      <div class="sp-placeholder">Monitor en vivo: disponible en Fase 2</div>
    </div>`;
  }

  sp.innerHTML = `
    <div class="sp-header">
      <div>
        <div class="sp-breadcrumb">${escapeHtml(client)} / ${escapeHtml(project)}</div>
        <div class="sp-title">${escapeHtml(svc.name)}</div>
        <div class="svc-kind-badge">${escapeHtml(svc.kind)}</div>
      </div>
      <button class="sp-close" id="spCloseBtn">×</button>
    </div>
    ${estadoBlock}
    ${metricasBlock}
    <div class="sp-block">
      <h4>Config</h4>
      <pre class="sp-config-json">${escapeHtml(JSON.stringify(svc.config || {}, null, 2))}</pre>
    </div>
    <div class="sp-block">
      <h4>Conexiones (${connections.length})</h4>
      ${connections.length ? `<ul class="sp-conn-list">${connections.map(c => {
        const dir = c.from === svc.id ? "→" : "←";
        const other = c.from === svc.id ? c.to : c.from;
        const lbl = c.label ? ` (${escapeHtml(c.label)})` : "";
        return `<li>este ${dir} ${escapeHtml(nameOf(other))}${lbl}</li>`;
      }).join("")}</ul>` : '<div class="sp-placeholder">Sin conexiones</div>'}
    </div>
    <div class="sp-actions">
      <button class="btn" id="spOpenForm">Editar en formulario</button>
      <button class="btn danger" id="spDeleteZone">Borrar zona</button>
    </div>`;
  sp.classList.remove("hidden");
  sidePanelOpen = true;
  sidePanelContext = { type: "zone", client, project, serviceId: svc.id };
  // Handlers
  sp.querySelector("#spCloseBtn").onclick = closeSidePanel;
  sp.querySelector("#spOpenForm").onclick = () => openServiceInForm(client, project, svc.id);
  sp.querySelector("#spDeleteZone").onclick = () => deleteZoneFromPanel(client, project, svc.id);
}

function openCityPanel(cityGroup) {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  const ud = cityGroup.userData;
  const meta = ud.meta || {};
  const nServices = (meta.services || []).length;
  const nConns = (meta.connections || []).length;
  sp.innerHTML = `
    <div class="sp-header">
      <div>
        <div class="sp-breadcrumb">${escapeHtml(ud.client)}</div>
        <div class="sp-title">${escapeHtml(ud.project)}</div>
      </div>
      <button class="sp-close" id="spCloseBtn">×</button>
    </div>
    <div class="sp-block">
      <h4>Contenido</h4>
      <div>${nServices} zona(s) · ${nConns} conexión(es)</div>
    </div>
    <div class="sp-actions">
      <button class="btn primary" id="spEnterCity">» Entrar en la ciudad</button>
      <button class="btn" id="spOpenCity">Abrir editor</button>
      <button class="btn" id="spRenameCity">Renombrar proyecto</button>
      <button class="btn danger" id="spDeleteCity">Borrar proyecto</button>
    </div>`;
  sp.classList.remove("hidden");
  sidePanelOpen = true;
  sidePanelContext = { type: "city", client: ud.client, project: ud.project };
  sp.querySelector("#spCloseBtn").onclick = closeSidePanel;
  sp.querySelector("#spEnterCity").onclick = () => {
    if (typeof enterCity === "function") enterCity(ud.client, ud.project);
  };
  sp.querySelector("#spOpenCity").onclick = () => openProjectMapForm(ud.client, ud.project);
  sp.querySelector("#spRenameCity").onclick = () => renameProjectFromPanel(ud.client, ud.project);
  sp.querySelector("#spDeleteCity").onclick = () => deleteProjectFromPanel(ud.client, ud.project);
}

function closeSidePanel() {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp) return;
  sp.classList.add("hidden");
  sidePanelOpen = false;
  sidePanelContext = null;
}

// --- Acciones del side panel ---------------------------------------------
function openServiceInForm(client, project, serviceId) {
  // Cambia a la pestaña "Proyectos" → entra al proyecto → sub-pestaña Mapa (Fase 1)
  // Reusa las funciones globales existentes de app.js.
  closeSidePanel();
  if (typeof window.openClient !== "function" || typeof window.openProject !== "function") {
    // Fallback: cambia de sección, el usuario hace click manual
    setSectionGlobal("dev");
    return;
  }
  setSectionGlobal("dev");
  Promise.resolve(window.openClient(client))
    .then(() => window.openProject(project))
    .then(() => {
      if (typeof window.projTabSet === "function") window.projTabSet("map");
      // Highlight: scroll-into-view de la fila del servicio si existe
      setTimeout(() => {
        const row = document.querySelector(`[data-svc-id="${serviceId}"]`);
        if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.style.outline = "2px solid #5a8ad0"; setTimeout(() => row.style.outline = "", 1500); }
      }, 300);
    });
}

function openProjectMapForm(client, project) {
  closeSidePanel();
  if (typeof window.openClient !== "function" || typeof window.openProject !== "function") {
    setSectionGlobal("dev"); return;
  }
  setSectionGlobal("dev");
  Promise.resolve(window.openClient(client))
    .then(() => window.openProject(project))
    .then(() => {
      if (typeof window.projTabSet === "function") window.projTabSet("map");
    });
}

function setSectionGlobal(s) {
  // setSection vive en app.js (global). Lo invocamos vía window.
  if (typeof window.setSection === "function") window.setSection(s);
}

async function deleteZoneFromPanel(client, project, serviceId) {
  if (!confirm("¿Borrar esta zona? También se borrarán sus conexiones.")) return;
  const rec = cityMap.get(`${client}/${project}`);
  if (!rec) return;
  const meta = rec.projectMeta;
  meta.services = (meta.services || []).filter(s => s.id !== serviceId);
  meta.connections = (meta.connections || []).filter(c => c.from !== serviceId && c.to !== serviceId);
  await doPersist(client, project, meta);
  // Reconstruye solo esa ciudad (representación del world)
  rebuildCity(client, project);
  // Si estamos en el interior de esa misma ciudad, reconstruir también el interior
  if (sceneMode === `interior:${client}/${project}` && interiorGroup) {
    scene.remove(interiorGroup);
    disposeGroup(interiorGroup);
    interiorGroup = buildInterior(client, project);
    scene.add(interiorGroup);
  }
  closeSidePanel();
  markDirty();
}

async function renameProjectFromPanel(client, project) {
  const nn = (prompt("Nuevo nombre del proyecto:", project) || "").trim();
  if (!nn || nn === project) return;
  try {
    const r = await fetch("/api/projects/rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, name: project, new_name: nn }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    closeSidePanel();
    await loadWorld();
  } catch (e) { alert("No se pudo renombrar: " + e.message); }
}

async function deleteProjectFromPanel(client, project) {
  if (!confirm(`¿Borrar el proyecto "${project}" y todo lo que contiene?`)) return;
  try {
    const r = await fetch("/api/projects/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, name: project }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "error"); }
    closeSidePanel();
    await loadWorld();
  } catch (e) { alert("No se pudo borrar: " + e.message); }
}

function rebuildCity(client, project) {
  const key = `${client}/${project}`;
  const rec = cityMap.get(key);
  if (!rec) return;
  worldGroup.remove(rec.group);
  disposeGroup(rec.group);
  cityMap.delete(key);
  const wp = rec.projectMeta.world_position || { x: 0, z: 0 };
  const newGroup = buildCity(client, project, rec.projectMeta, wp);
  worldGroup.add(newGroup);
}

// --- Esc handler ----------------------------------------------------------
function onKeyDown(ev) {
  if (ev.key !== "Escape") return;
  // Cancelar drag en curso: revertir
  if (draggingObj && dragStart) {
    if (draggingObj.userData.type === "zone") {
      draggingObj.position.x = dragStart.x0;
      draggingObj.position.z = dragStart.z0;
      updateCablesForZone(draggingObj);
    } else {
      draggingObj.position.x = dragStart.x0;
      draggingObj.position.z = dragStart.z0;
    }
    draggingObj = null;
    dragStart = null;
    dragMoved = false;
    markDirty();
    return;
  }
  // Si hay side panel abierto, cerrarlo
  if (sidePanelOpen) { closeSidePanel(); return; }
  // Si estamos en interior, salir al mundo (Fase 4)
  if (sceneMode.startsWith("interior:")) {
    if (typeof exitCity === "function") exitCity();
    return;
  }
  // Si Edit Mode activo, desactivar
  if (editMode) { setEditMode(false); return; }
  // Si no estamos en vista mundo, fly-to-world
  if (camera && camera.userData.frustumSize !== FRUSTUM_DEFAULT) { flyToWorld(); return; }
}

window.addEventListener("keydown", onKeyDown);

// ============================================================ //
// Fase 4 — Interior de la ciudad (drill-in)                     //
// ============================================================ //

// Estado nuevo
let sceneMode = "world";              // "world" | "interior:<client>/<project>"
let interiorGroup = null;             // THREE.Group con el interior actual (null en world)
let worldCameraSnapshot = null;       // {position, frustumSize} para restaurar al salir
let savedEditModeBeforeEnter = false; // recordar Edit Mode al entrar para restaurar al salir
const mockMetrics = new Map();        // serviceId → {status, cpu, ram, disk, uptimeSeconds, lastUpdate}
let mockTicker = null;                // setInterval handle
const INTERIOR_FRUSTUM     = 25;
const INTERIOR_FRUSTUM_MIN = 10;
const INTERIOR_FRUSTUM_MAX = 40;
const BARRIO_RADIUS_SLOT   = 10;      // radio donde se posicionan los barrios
const BARRIO_FOOTPRINT_R   = 4;       // radio del footprint circular de un barrio
const COMPONENT_RADIUS     = 2;       // radio del círculo interior donde se colocan los componentes
const COMPONENT_SCALE      = 2;       // escala respecto a la primitiva del world

// Mapping kind → rol semántico para agrupar barrios por categoría
// (en vez de "barrio vps" + "barrio docker" separados, agrupamos en "infraestructura")
const KIND_ROLE = {
  vps:      "infraestructura",
  docker:   "infraestructura",
  postgres: "base de datos",
  n8n:      "backend",
  chatwoot: "comunicaciones",
  github:   "código",
  linear:   "gestión",
  custom:   "otros",
};

// Colores para el footprint del barrio según rol
const ROLE_COLORS = {
  "infraestructura": 0x8b949e,
  "base de datos":   0x336791,
  "backend":         0xa371f7,
  "comunicaciones":  0xf48120,
  "código":          0xe6edf3,
  "gestión":         0x5e6ad2,
  "otros":           0x6e7681,
};

function roleOf(kind) { return KIND_ROLE[kind] || KIND_ROLE.custom; }

// Helpers --------------------------------------------------- //
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function humanUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function statusText(status) {
  return status === "ok"   ? "operativo"
       : status === "warn" ? "advertencia"
       :                     "caído";
}

// Stubs — se implementan en Tasks 3-7
let enterCity;
let exitCity;
let buildInterior;
let initMockMetricsForServices;
let startMockTicker;
let stopMockTicker;
let refreshOpenPanelMetrics;
let showHudInterior;

// Implementación de showHudInterior (visibilidad de botones HUD)
showHudInterior = function(inInterior) {
  const back = container.querySelector("#mapBackBtn");
  const edit = container.querySelector("#mapEditToggle");
  if (back) back.classList.toggle("hidden", !inInterior);
  if (edit) edit.classList.toggle("hidden", !!inInterior);
};

enterCity = function(client, project) {
  if (!client || !project) return;
  if (sceneMode.startsWith("interior:")) return;

  worldCameraSnapshot = {
    position: camera.position.clone(),
    frustumSize: camera.userData.frustumSize,
  };
  savedEditModeBeforeEnter = editMode;
  if (editMode) setEditMode(false);

  worldGroup.visible = false;

  if (sidePanelOpen) closeSidePanel();

  // Inicializar mock metrics ANTES de buildInterior para que las labels los lean
  if (typeof initMockMetricsForServices === "function") {
    const rec = cityMap.get(`${client}/${project}`);
    if (rec) initMockMetricsForServices(rec.projectMeta.services || []);
  }

  interiorGroup = buildInterior(client, project);
  scene.add(interiorGroup);

  camera.position.set(50, 50, 50);
  setFrustum(INTERIOR_FRUSTUM);
  camera.lookAt(0, 0, 0);

  sceneMode = `interior:${client}/${project}`;
  if (typeof showHudInterior === "function") showHudInterior(true);

  if (typeof startMockTicker === "function") startMockTicker();

  markDirty();
};

exitCity = function() {
  if (!sceneMode.startsWith("interior:")) return;

  if (typeof stopMockTicker === "function") stopMockTicker();

  if (sidePanelOpen) closeSidePanel();

  if (interiorGroup) {
    scene.remove(interiorGroup);
    disposeGroup(interiorGroup);
    interiorGroup = null;
  }

  worldGroup.visible = true;

  if (worldCameraSnapshot) {
    camera.position.copy(worldCameraSnapshot.position);
    setFrustum(worldCameraSnapshot.frustumSize);
    camera.lookAt(0, 0, 0);
    worldCameraSnapshot = null;
  }

  if (savedEditModeBeforeEnter) setEditMode(true);
  savedEditModeBeforeEnter = false;

  sceneMode = "world";
  if (typeof showHudInterior === "function") showHudInterior(false);

  markDirty();
};

buildInterior = function(client, project) {
  const g = new THREE.Group();
  g.userData = { type: "interior", client, project };

  const cityRec = cityMap.get(`${client}/${project}`);
  const services = cityRec && cityRec.projectMeta && cityRec.projectMeta.services
    ? cityRec.projectMeta.services
    : [];

  // Empty state — ciudad sin servicios
  if (services.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "interior-empty";
    emptyDiv.innerHTML = '<strong>Ciudad vacía</strong>Añade servicios en el editor (Proyectos → Mapa)';
    const emptyLabel = new CSS2DObject(emptyDiv);
    emptyLabel.position.set(0, 1, 0);
    g.add(emptyLabel);
    return g;
  }

  // Agrupar por ROL (categoría semántica) en vez de por kind directo:
  // así "infraestructura" agrupa vps + docker, "base de datos" agrupa postgres, etc.
  const byRole = new Map();
  for (const s of services) {
    const r = roleOf(s.kind);
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r).push(s);
  }

  const barrioRoles = [...byRole.keys()];
  const N = barrioRoles.length;

  // Mapa serviceId → mesh global (para que los cables del Task 5 puedan encontrarlos)
  const interiorZoneMeshes = new Map();
  g.userData.interiorZoneMeshes = interiorZoneMeshes;

  barrioRoles.forEach((role, idx) => {
    const barrio = new THREE.Group();
    barrio.userData = { type: "barrio", role };

    // Posición polar (N=1: centro)
    if (N === 1) {
      barrio.position.set(0, 0, 0);
    } else {
      const angle = (2 * Math.PI * idx) / N;
      barrio.position.set(
        BARRIO_RADIUS_SLOT * Math.cos(angle),
        0,
        BARRIO_RADIUS_SLOT * Math.sin(angle)
      );
    }

    // Footprint del barrio: color del ROL
    const roleColor = ROLE_COLORS[role] || ROLE_COLORS["otros"];
    const footprintGeo = new THREE.CircleGeometry(BARRIO_FOOTPRINT_R, 32);
    const footprintMat = new THREE.MeshBasicMaterial({
      color: roleColor, opacity: 0.25, transparent: true, side: THREE.DoubleSide,
    });
    const footprint = new THREE.Mesh(footprintGeo, footprintMat);
    footprint.rotation.x = -Math.PI / 2;
    footprint.position.y = 0.02;
    footprint.userData = { type: "barrio-footprint", role };
    barrio.add(footprint);

    // Label del barrio: nombre del ROL
    const lblDiv = document.createElement("div");
    lblDiv.className = "barrio-label";
    lblDiv.textContent = `barrio ${role}`;
    const barrioLabel = new CSS2DObject(lblDiv);
    barrioLabel.position.set(0, 0.5, 0);
    barrio.add(barrioLabel);

    // Componentes (zonas) dentro del barrio — cada uno usa SU propia primitiva
    // y color del KIND (así dentro del barrio sigues distinguiendo tipos)
    const items = byRole.get(role);
    const M = items.length;
    items.forEach((svc, i) => {
      const angle = (2 * Math.PI * i) / Math.max(M, 3);
      const lx = COMPONENT_RADIUS * Math.cos(angle);
      const lz = COMPONENT_RADIUS * Math.sin(angle);

      const geoFactory = ZONE_PRIMITIVES[svc.kind] || ZONE_PRIMITIVES.custom;
      const geo = geoFactory();
      const kindColor = ZONE_COLORS[svc.kind] || ZONE_COLORS.custom;
      const mat = new THREE.MeshStandardMaterial({ color: kindColor });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(COMPONENT_SCALE, COMPONENT_SCALE, COMPONENT_SCALE);
      mesh.position.set(lx, ZONE_Y * COMPONENT_SCALE, lz);
      mesh.userData = {
        type: "zone",
        service: svc,
        client, project,
        inInterior: true,
      };
      barrio.add(mesh);
      interiorZoneMeshes.set(svc.id, mesh);

      // Label CSS2D con dot de estado
      const m = mockMetrics.get(svc.id);
      const statusCls = m ? `status-${m.status}` : "status-ok";
      const zlbl = document.createElement("div");
      zlbl.className = "zone-label";
      zlbl.dataset.serviceId = svc.id;
      zlbl.innerHTML = `<span class="status-dot ${statusCls}"></span><span>${escapeHtml(svc.name)} <span style="color:var(--muted);font-size:10px">[${escapeHtml(svc.kind)}]</span></span>`;
      const label = new CSS2DObject(zlbl);
      label.position.set(0, 2.2, 0);
      mesh.add(label);
    });

    g.add(barrio);
  });

  // (cables abajo)
  // Cables (intra-ciudad) renderizados como carreteras (tubo asfalto + dashed encima)
  const connections = cityRec && cityRec.projectMeta && cityRec.projectMeta.connections
    ? cityRec.projectMeta.connections
    : [];
  for (const conn of connections) {
    const from = interiorZoneMeshes.get(conn.from);
    const to   = interiorZoneMeshes.get(conn.to);
    if (!from || !to) continue;

    // Posiciones en coords mundo (cada mesh está dentro de su barrio Group)
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    from.getWorldPosition(p0);
    to.getWorldPosition(p1);
    p0.y = ZONE_Y * 0.6;
    p1.y = ZONE_Y * 0.6;

    // Curva suave entre los dos puntos
    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
    mid.y = ZONE_Y * 0.65;
    const curve = new THREE.CatmullRomCurve3([p0, mid, p1]);

    // Tubo asfalto
    const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.18, 8, false);
    const tubeMat = new THREE.MeshBasicMaterial({ color: 0x333740 });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.userData = { type: "interior-road-asphalt", connection: conn };
    g.add(tube);

    // Líneas blancas dashed encima
    const segments = 48;
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const p = curve.getPoint(i / segments);
      p.y += 0.05;
      pts.push(p);
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xffffff,
      dashSize: 0.5,
      gapSize: 0.5,
      linewidth: 1,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.computeLineDistances();
    line.userData = { type: "interior-road-line", connection: conn };
    g.add(line);
  }

  return g;
};

initMockMetricsForServices = function(services) {
  for (const s of services) {
    if (mockMetrics.has(s.id)) continue;    // ya inicializado en esta sesión
    const h = simpleHash(s.id);
    const mod = h % 10;
    const status = mod < 7 ? "ok" : mod < 9 ? "warn" : "down";
    const cpu  = 20 + (h % 60);
    const ram  = 30 + ((h >>> 8) % 50);
    const disk = 10 + ((h >>> 16) % 70);
    const uptimeSeconds = 86400 + ((h >>> 4) % (86400 * 30));
    mockMetrics.set(s.id, {
      status, cpu, ram, disk, uptimeSeconds, lastUpdate: 0,
    });
  }
};

startMockTicker = function() {
  if (mockTicker) return;
  mockTicker = setInterval(() => {
    if (!sceneMode.startsWith("interior:")) return;
    for (const m of mockMetrics.values()) {
      m.cpu  = clamp(m.cpu  + (Math.random() * 6 - 3), 0, 100);
      m.ram  = clamp(m.ram  + (Math.random() * 4 - 2), 0, 100);
      m.disk = clamp(m.disk + (Math.random() * 1 - 0.5), 0, 100);
      m.uptimeSeconds += 2;
      m.lastUpdate = Date.now();
    }
    if (typeof refreshOpenPanelMetrics === "function") refreshOpenPanelMetrics();
  }, 2000);
};

stopMockTicker = function() {
  if (mockTicker) {
    clearInterval(mockTicker);
    mockTicker = null;
  }
};

refreshOpenPanelMetrics = function() {
  const sp = container.querySelector("#mapSidePanel");
  if (!sp || sp.classList.contains("hidden")) return;
  if (!sidePanelContext || sidePanelContext.type !== "zone") return;
  const id = sidePanelContext.serviceId;
  const m = mockMetrics.get(id);
  if (!m) return;
  const cpuTxt = Math.round(m.cpu) + "%";
  const ramTxt = Math.round(m.ram) + "%";
  const diskTxt = Math.round(m.disk) + "%";
  const upTxt = humanUptime(m.uptimeSeconds);
  const updateField = (sel, val) => { const el = sp.querySelector(sel); if (el) el.textContent = val; };
  const updateBar = (sel, val) => { const el = sp.querySelector(sel); if (el) el.style.width = val + "%"; };
  updateField('[data-metric="cpu"]',  cpuTxt);
  updateField('[data-metric="ram"]',  ramTxt);
  updateField('[data-metric="disk"]', diskTxt);
  updateField('[data-metric="uptime"]', upTxt);
  updateBar('[data-metric-bar="cpu"]',  Math.round(m.cpu));
  updateBar('[data-metric-bar="ram"]',  Math.round(m.ram));
  updateBar('[data-metric-bar="disk"]', Math.round(m.disk));
};
