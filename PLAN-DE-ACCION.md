# PLAN DE ACCIÓN — Panel Claude

> Documento vivo de ejecución. Marca el **orden de desarrollo por fases**.
> La visión y el "por qué" están en [CONTEXTO.md](./CONTEXTO.md); lo técnico en
> [CLAUDE.md](./CLAUDE.md). Vamos fase a fase: no se abre la siguiente sin cerrar
> lo imprescindible de la anterior.

## Objetivo a desarrollar (norte)

Un **back-office visual** donde cada proyecto se ve como un **mapa** (metáfora
del coche) con su estado y **alertas en tiempo real sobre cada parte**, asistido
por un **agente Claude** integrado, y nutrido por una **monitorización con
alertas configurables**.

---

## Fase 0 — Base y reorganización  ✅ (cerrada)
*Dejar el terreno limpio antes de construir.*

- [x] Revisar y cerrar el cambio pendiente en `backend/server.py` (mejora del
      collector de monitorización: resolución de contenedores por prefijo +
      healthcheck n8n por `docker exec`). Probado (servicio reiniciado OK) y
      commiteado (`b638559`).
- [x] Consolidar documentación: CONTEXTO + CLAUDE + este plan (`7b516b6`).
- [→] Decidir el destino del chat agéntico actual → se trata en **Fase 1**.
- [x] Inventario de lo reutilizable (abajo).

### Inventario de lo reutilizable (foto actual de `server.py` + frontend)

| Pieza | Dónde | Se reutiliza en |
|-------|-------|-----------------|
| **Monitor**: `ssh_run`, `COLLECTOR_TMPL`, `build_collector`, parseo (`_n8n`, etc.) | backend | Fase 2 (alertas) y Fase 3 (monitor por proyecto) |
| **Modelo "proyectos"**: clone/pull/checkout/delete, sesión y lock por proyecto | backend + `app.js` | Fase 3 (proyectos por túnel) y Fase 4 (vista por proyecto) |
| **Auth + 2FA + sesiones** (scrypt, TOTP, cookie segura, bloqueo) | backend | Base transversal de toda la plataforma |
| **Puente a `claude`** (chat streaming NDJSON) | backend + `app.js` | Fase 1 (agente de ayuda) |
| **Frontend**: pestañas, modal de host, render de tarjetas | `index.html`/`app.js`/`styles.css` | Fase 2 y Fase 4 (UI visual) |

**Hecho cuando:** repo sin cambios sueltos, docs alineadas, y una foto clara de
qué se reutiliza. → **Cumplido.**

---

## Fase 1 — Claude como agente de ayuda de la plataforma
*Claude deja de ser "consola sobre la VPS" y pasa a asistente del producto.*

- [ ] Definir el **rol y alcance** del agente (qué puede hacer, qué no).
- [ ] Reconvertir la pestaña de chat en el **asistente de la plataforma**.
- [ ] **Integración con Linear** (vía agente / API): traer incidencias y
      proyectos; definir qué se muestra y qué acciones se permiten.
- [ ] Acotar permisos del agente si procede (revisar
      `--dangerously-skip-permissions`).

**Hecho cuando:** puedo pedirle ayuda al agente dentro del panel y consultar mi
trabajo de Linear desde él.

---

## Fase 2 — Monitorización con alertas configurables
*De visor a visor + reglas de alerta.*

- [ ] Diseñar el **modelo de alerta**: métrica (CPU, RAM, disco, contenedor
      caído, BD sin responder…), condición/umbral, severidad, estado
      (activa/resuelta).
- [ ] UI para **crear/editar/borrar alertas** sobre cada host monitorizado.
- [ ] **Evaluación** de las reglas en cada recolección y persistencia del estado.
- [ ] **Publicar** las alertas en una forma que el panel interactivo (Fase 4)
      pueda consumir (API interna de alertas por proyecto/parte).

**Hecho cuando:** puedo configurar una alerta (p.ej. "disco > 90%") y verla
dispararse y resolverse.

---

## Fase 3 — Proyectos conectados por túnel (monitorización en directo)
*Replicar el modelo "por proyecto" también para la vista/monitorización.*

- [ ] Modelo de **proyecto monitorizable**: cada proyecto se **conecta por túnel
      SSH** a este servidor y expone su estado en vivo.
- [ ] Recolector por proyecto (reutilizar el de la VPS): sistema, Docker,
      servicios, BD del proyecto.
- [ ] Gestión de varios proyectos en paralelo (alta, prueba de conexión, baja).
- [ ] Asociar las **alertas (Fase 2)** a cada proyecto.

**Hecho cuando:** doy de alta un proyecto remoto, se conecta por túnel y veo su
estado en directo.

---

## Fase 4 — Panel interactivo visual (la metáfora del coche)  ⭐
*La pieza estrella: el mapa visual del proyecto con alertas encima de cada parte.*

- [ ] Definir cómo se modelan las **"partes" del proyecto** (componentes:
      servicios, BD, etc.) y cómo se mapea cada alerta a su parte.
- [ ] Render visual del proyecto como **mapa/diagrama** donde cada parte muestra
      su estado y **se ilumina con la alerta** (rueda pinchada → alerta en la
      rueda).
- [ ] Capas complementarias: **tecnologías usadas**, **esquema y relaciones de la
      BD** con sus **pasos de seguridad**, y (opcional) **línea temporal** del
      desarrollo.
- [ ] Enfoque **para no desarrolladores**: claridad visual sobre detalle técnico.

**Hecho cuando:** abro un proyecto y veo su "coche" con las alertas activas
señaladas sobre la parte concreta afectada.

---

## Notas de método

- Cada fase termina con algo **usable y probado**, no solo código.
- Antes de empezar una fase, resolver sus **preguntas abiertas** en CONTEXTO.md.
- Mantener el principio de stack ligero (Python stdlib); si la Fase 4 lo exige,
  plantear la excepción explícitamente.
