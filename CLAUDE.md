# CLAUDE.md — Panel Claude

Guía para agentes que trabajen en este repo. Léela antes de tocar nada.

## Qué es

Panel web para **chatear con Claude (agéntico) y que actúe sobre la VPS**. El
backend hace de puente entre el navegador y el CLI `claude` (ya instalado y
autenticado), ejecutando el loop completo del agente con streaming al frontend.

```
Navegador (frontend) ──► backend (127.0.0.1:8787) ──► claude -p (loop completo)
     chat / 2FA            API + streaming NDJSON         agente sobre la VPS
```

## Finalidad

Tener un punto de control web, seguro y autohospedado, para:
- **Hablar con Claude** y que opere sobre la propia VPS (bash, ficheros, git…).
- **Gestionar proyectos de desarrollo**: jerarquía Cliente → Proyecto → Repos,
  clonar repos privados de GitHub, cambiar de rama, pull, etc. Cada proyecto es
  un `cwd` aislado con su propia sesión de chat.
- **Monitorizar una segunda VPS** por SSH (sistema, Docker, n8n, PostgreSQL).

Es la base de un futuro **back-office** en la VPS.

## Stack y restricciones

- **Backend: Python puro, solo stdlib.** NO añadir dependencias (sin pip, sin
  frameworks). Si algo necesita una librería externa, primero proponlo.
- **Frontend: vanilla** (HTML + CSS + JS sin build, sin framework).
- El backend **sirve el frontend** (mismo origen → cookie de sesión sin CORS).

## Estructura

```
claude-panel/
├── backend/
│   ├── server.py            # TODO el backend: HTTP, login+2FA, chat, proyectos, monitor
│   ├── qr.py                # generador de QR en stdlib (alta del 2FA)
│   ├── claude-panel.service # unit systemd (instalada en /etc/systemd/system/)
│   ├── panel.conf           # config real (600, NO en git)
│   ├── panel.conf.example   # plantilla
│   ├── monitor.json         # hosts a monitorizar (600, NO en git)
│   └── sessions.json        # sesiones activas (NO en git)
└── frontend/
    ├── index.html
    ├── app.js
    └── styles.css
```

## Comandos

```bash
# Desarrollo (foreground)
python3 backend/server.py

# Gestión de credenciales (cierran todas las sesiones)
python3 backend/server.py --set-password   # contraseña por teclado (getpass)
python3 backend/server.py --totp           # muestra secreto/URI/QR del 2FA
python3 backend/server.py --reset-totp      # regenera el secreto 2FA

# Producción (systemd) — ya instalado, active + enabled
sudo systemctl restart claude-panel
sudo systemctl status claude-panel
journalctl -u claude-panel -f              # contraseña + 2FA al arrancar
```

## Acceso

Solo escucha en `127.0.0.1:8787`. Para entrar, túnel SSH desde la máquina local:
`ssh -L 8787:127.0.0.1:8787 adelpozor@IP_VPS` y abrir <http://localhost:8787>.
Login = contraseña **+** código TOTP de 6 dígitos.

## API (en server.py)

- Auth/sesión: login con contraseña+2FA, cookie HttpOnly/SameSite=Strict/Secure,
  logout, bloqueo tras 5 intentos.
- Chat: streaming NDJSON del loop de `claude`.
- Proyectos: `GET /api/projects`, `POST /api/projects/{clone,pull,checkout,delete}`,
  `GET /api/projects/branches`.
- Monitor: `GET /api/monitor/hosts`, `GET /api/monitor/report?host=<id>`,
  `POST /api/monitor/{hosts/save,hosts/delete,test}`.

## Seguridad (crítico)

- El agente corre con `--dangerously-skip-permissions`: ejecuta bash y edita
  ficheros **sin pedir confirmación**. Quien pase el login controla la VPS.
  Mantener SIEMPRE tras túnel SSH o TLS + contraseña + 2FA. Nunca en HTTP abierto.
- Secretos (`panel.conf`, `monitor.json`, `sessions.json`) tienen permisos 600 y
  están en `.gitignore`. No los subas ni los vuelques en logs/respuestas.
- Para acotar capacidades del agente: array `cmd` en `_chat` de `server.py`
  (cambiar a `--permission-mode plan` o usar `--allowed-tools`/`--disallowed-tools`).

## Convenciones

- Sigue el estilo del código existente (stdlib, sin deps, vanilla en el front).
- Tras tocar credenciales o la unit: `sudo systemctl restart claude-panel`.
- Comprueba `git status` antes de commitear: puede haber trabajo a medias en
  `server.py`.
```
