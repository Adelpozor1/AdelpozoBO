# Panel Claude

Panel web para hablar con Claude (agéntico) y que actúe sobre una VPS.
Backend en **Python puro** (solo la stdlib) + el CLI `claude` ya instalado y
autenticado. Sin dependencias que instalar.

```
Navegador (frontend) ──► backend (127.0.0.1:8787) ──► claude -p (loop completo)
        chat / 2FA            API + streaming NDJSON         agente sobre la VPS
```

## Estructura

```
claude-panel/
├── backend/                 # servidor Python (API + puente a `claude`)
│   ├── server.py            # HTTP, login + 2FA, streaming del chat
│   ├── qr.py                # generador de QR en stdlib (para el alta del 2FA)
│   ├── claude-panel.service # unit de systemd
│   └── panel.conf.example   # plantilla de configuración (copiar a panel.conf)
└── frontend/                # interfaz web (estáticos)
    ├── index.html
    ├── styles.css
    └── app.js
```

El backend **sirve el frontend** (mismo origen → la cookie de sesión segura
funciona sin CORS). La carpeta a servir se configura con `staticdir` en
`panel.conf`; por defecto es `../frontend`.

## Puesta en marcha

```bash
git clone <este-repo> claude-panel
cd claude-panel/backend
cp panel.conf.example panel.conf      # password/secret/totp se autogeneran
python3 server.py                     # arranca en 127.0.0.1:8787
```

Al arrancar imprime la contraseña y la **inscripción del 2FA** (secreto + QR).

### Acceder (túnel SSH)

El backend solo escucha en `127.0.0.1` (no expone nada a internet). Desde tu
máquina local:

```bash
ssh -L 8787:127.0.0.1:8787 adelpozor@IP_DE_LA_VPS
```

Abre <http://localhost:8787> e introduce **contraseña + código 2FA**.

## 2FA (TOTP) — segundo factor obligatorio

El login pide contraseña **+** un código de 6 dígitos (Google Authenticator,
Authy, 1Password…). Todo con la stdlib: sin pip, sin SMTP, sin servicios
externos; el secreto vive solo en `panel.conf` (permisos 600) y nunca sale de
la VPS.

```bash
python3 backend/server.py --totp     # secreto + URI (+ QR si hay qrencode)
```

En la app de autenticación elige **"introducir clave manualmente"** y pega el
*Secreto* (base32). Si instalas `qrencode` (`sudo apt install qrencode`) el
comando muestra un QR más compacto; si no, se dibuja uno con `qr.py`.

Tras **5 intentos fallidos** el login se bloquea 5 minutos. Para desactivar el
2FA (no recomendado): `"totp_enabled": false` en `panel.conf`.

## Gestión del login (sin exponer secretos)

La contraseña se guarda **hasheada** (scrypt), nunca en texto plano. Para
crearla/cambiarla de forma interactiva (no se escribe en pantalla ni en logs):

```bash
python3 backend/server.py --set-password    # pide la contraseña por teclado (getpass)
python3 backend/server.py --reset-totp       # regenera el secreto 2FA y lo reimprime
```

Ambos **cierran todas las sesiones abiertas**. Tras usarlos:
`sudo systemctl restart claude-panel`.

**Sesiones:** cada login crea un token aleatorio con caducidad (`session_days`,
30 por defecto), guardado en `sessions.json` (revocable). El panel tiene botón
**Salir** (logout) que invalida la sesión en el servidor. La cookie es
`HttpOnly`, `SameSite=Strict` y `Secure` (`cookie_secure`).

## Zona de desarrollo (proyectos)

Cada proyecto es una subcarpeta de `projects_dir` (`~/projects` por defecto), un
`git clone`. Desde la web (barra lateral):

- **+ Clonar**: pega una URL git (SSH `git@…` para repos privados — la clave de
  la VPS está en tu cuenta de GitHub, así que clona tus privados).
- Selecciona un proyecto → el chat de Claude trabaja **dentro de esa carpeta**
  (`cwd` = proyecto), con sesión propia.
- Barra del proyecto: **Pull**, cambiar de **rama**, **Nueva** (reinicia la
  conversación) y **Borrar**.
- **Varios proyectos en paralelo**: cada uno tiene su lock; puedes lanzar Claude
  en uno y, mientras trabaja, cambiar a otro.

Claude corre con `--dangerously-skip-permissions` también aquí (autonomía total
dentro del proyecto). API: `GET /api/projects`, `POST /api/projects/{clone,pull,
checkout,delete}`, `GET /api/projects/branches`.

## Persistencia (systemd)

```bash
sudo cp backend/claude-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-panel
journalctl -u claude-panel -f         # contraseña + inscripción 2FA al arrancar
```

## Configuración (`panel.conf`)

JSON autogenerado en el primer arranque (permisos 600, **no se sube a git**):

| Campo          | Qué es                                                    |
|----------------|-----------------------------------------------------------|
| `password_hash` | Hash scrypt de la contraseña (gestiónalo con `--set-password`) |
| `totp_secret`   | Secreto base32 del 2FA (no lo toques; ver `--totp`)          |
| `totp_enabled`  | `true` = exige código 2FA en el login                       |
| `host`          | Interfaz de escucha (por defecto `127.0.0.1`)               |
| `port`          | Puerto (`8787`)                                             |
| `staticdir`     | Carpeta del frontend a servir (por defecto `../frontend`)   |
| `workdir`       | Directorio donde trabaja el agente                          |
| `model`         | `null` (usa el del CLI), o `"opus"` / `"sonnet"` / …        |
| `claude_bin`    | Ruta al CLI `claude` (`null` = autodetectar)                |
| `cookie_secure` | Cookie solo por HTTPS (déjalo en `true`)                    |
| `session_days`  | Caducidad de la sesión en días (30)                        |
| `projects_dir`  | Carpeta de proyectos de desarrollo (`~/projects`)          |

## Seguridad (importante)

El agente corre con `--dangerously-skip-permissions`: ejecuta bash, edita
ficheros, etc. **sin pedir confirmación**. Quien pase el login controla la VPS.
Mantenlo tras túnel SSH o TLS + contraseña + 2FA, nunca en HTTP abierto a
internet.

Para acotar capacidades, edita el array `cmd` en `backend/server.py` (`_chat`):
cambia `--dangerously-skip-permissions` por `--permission-mode plan` (solo
planifica) o añade `--allowed-tools` / `--disallowed-tools`.
