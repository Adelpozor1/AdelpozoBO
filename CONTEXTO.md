# CONTEXTO — Hacia dónde va Panel Claude

> Documento vivo. Describe **qué quiero hacer** con este proyecto (la visión y
> las decisiones), no cómo está implementado hoy. Para lo técnico ver
> [CLAUDE.md](./CLAUDE.md).

## Visión

Reorganizar el panel para que deje de girar en torno al "chat agéntico sobre la
VPS" y se convierta en un **back-office visual**. El objetivo es **ver y
entender de forma gráfica el desarrollo** que estoy haciendo, de manera que sea
comprensible incluso **para personas no desarrolladoras** (clientes, socios,
yo mismo de un vistazo).

## Cambio de enfoque

- **Antes:** el corazón era hablar con Claude para que actuara sobre la VPS
  (bash, ficheros, git con `--dangerously-skip-permissions`).
- **Ahora:** Claude pasa a ser **un medio, no el centro**. Su papel se reduce a:
  - Conexión / integración con **Linear**.
  - Apoyo a la **monitorización**.

## Los tres pilares

### 1. Linear
Claude es el **agente de ayuda de la plataforma**: el asistente que acompaña al
usuario dentro del back-office (explicar, guiar, ejecutar acciones de apoyo) y
que además sirve de puente hacia **Linear** (traer incidencias, proyectos,
estados…). No es "una forma de conectarse"; es **el asistente del producto**.
*(Por definir: alcance exacto de lo que puede hacer y qué trae de Linear.)*

### 2. Monitorización (visor → visor + alertas)
Hoy es un **visor** del estado de una VPS por SSH (sistema, Docker, n8n,
PostgreSQL). Evoluciona a un visor donde **configurar alertas** (reglas sobre
métricas: umbrales, condiciones). Esas alertas no se quedan aquí: **se publican
para que el panel interactivo las muestre** sobre la parte del proyecto afectada.

### 3. Panel interactivo (la metáfora del coche)  ⭐ (lo nuevo)
La pieza central. Igual que hoy el trabajo se organiza **por proyectos**, la
vista también será **por proyecto**: se recogen proyectos, se **conectan a este
servidor por túnel** y se obtiene **monitorización completa del proyecto en
directo**.

No es solo "ver las tecnologías": es **ver las alertas sobre cada parte del
proyecto**. La metáfora: si el proyecto es un **coche**, quiero ver el coche, y
que **salte una alerta encima de la rueda** si la rueda se ha pinchado. Es decir,
un **mapa visual del proyecto** donde cada componente puede iluminarse con su
estado/alerta en tiempo real.

Complementos de esa vista (más adelante): tecnologías usadas, esquema y
**relaciones de la base de datos** con sus **pasos de seguridad**, y una posible
**línea temporal** del desarrollo. Todo pensado para que lo entienda alguien que
**no programa**.

## Principios

- **Para no desarrolladores**: claridad visual por encima del detalle técnico.
- Mantener el stack sin dependencias pesadas (backend Python stdlib; ver
  CLAUDE.md). Revisar si la parte visual exige replantear esto.
- Seguridad: sigue siendo un panel privado tras túnel SSH + 2FA.

## Preguntas abiertas (a resolver juntos)

1. **Mapa del proyecto ("coche")**: ¿cómo se definen las "partes" del proyecto
   (rueda, motor…)? ¿Se describen a mano por proyecto, o se infieren (servicios
   Docker, componentes del repo)? ¿Quién dibuja el mapa?
2. **Túnel por proyecto**: ¿cada proyecto monitorizado expone su estado por SSH
   como la VPS actual? ¿Qué se recoge de cada uno (Docker, BD, servicios)?
3. **Alertas**: ¿sobre qué métricas inicialmente (CPU, RAM, disco, contenedor
   caído, BD sin responder)? ¿Cómo se mapea una alerta a una "parte" del coche?
4. **Base de datos** en la vista: ¿se introspecciona en vivo (leer el esquema
   real) o se describe a mano?
5. **Audiencia**: ¿quién verá esto? ¿clientes con acceso, o solo tú lo enseñas?
   ¿Hace falta una vista pública/compartible?
6. **Linear**: ¿qué quieres ver/hacer con Linear desde el agente/panel?
   *(Decidido: conexión por API key personal al inicio; OAuth más adelante.)*

### Decisiones cerradas
- **Auth de Claude**: el asistente **reutiliza el `claude` ya logueado en la VPS**
  (la suscripción existente) → cero gasto extra. Sin API key dedicada.
- **Alcance del asistente**: solo ayuda/chat, **sin actuar sobre la VPS**.
- **Linear**: token personal en `backend/linear.token` (600, gitignored, nunca
  expuesto). OAuth ("conectar tu proyecto") más adelante.

## Estado

- [x] Borrador inicial de la visión (este documento)
- [ ] Resolver preguntas abiertas
- [ ] Definir la arquitectura de la "vista visual del código"
- [ ] Plan de reorganización (qué se quita, qué se mantiene, qué se añade)
