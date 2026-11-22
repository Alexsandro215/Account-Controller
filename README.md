# Account Controller

Bóveda personal de contraseñas que vive en tu Telegram: un bot con botones y una mini app, con
cifrado de extremo a extremo protegido por una contraseña maestra que solo tú conoces.

## Qué hace

- **Bóveda cifrada de verdad.** Cada contraseña, nota y semilla 2FA se sella con la llave pública de
  la bóveda (X25519 + AES-256-GCM). La llave privada solo se abre con tu **contraseña maestra**
  (scrypt + secreto del servidor) o con tu **código de recuperación**, y vive solo en memoria
  mientras la bóveda está abierta. Quien robe la base de datos, o la base y el servidor, no puede
  leer nada sin tu contraseña maestra.
- **Bot con botones:** categorías, búsqueda tolerante a errores ("netflx" encuentra Netflix),
  crear, editar, borrar, historial de contraseñas anteriores.
- **Códigos 2FA (TOTP):** guarda el secreto (texto, enlace `otpauth://` o **foto del QR**) y el
  bot te da el código de 6 dígitos.
- **Generador** de contraseñas seguras, sin caracteres ambiguos.
- **Revisión de salud:** contraseñas filtradas en hackeos conocidos (Have I Been Pwned, con
  k-anonimato), repetidas, débiles y sin cambiar en más de un año.
- **Importar** desde Chrome, Edge, Brave, Firefox, Bitwarden, 1Password o KeePass (CSV).
- **Respaldos cifrados** automáticos cada semana a tu chat, que se restauran mandándolos al bot.
- **Mini app** dentro de Telegram, opcional.
- **Historial de actividad:** quién abrió la bóveda, qué se vio, cambios y fallos.

## Seguridad

| Amenaza | Protección |
| --- | --- |
| Roban la base de datos | Todo está sellado. La contraseña maestra además lleva el secreto del servidor, así que no se puede atacar sin él. |
| Roban la base y el servidor | Hay que adivinar tu contraseña maestra con scrypt (64 MB por intento). Usa una frase larga. |
| Alguien toma tu Telegram | Para ver, editar o borrar necesita la contraseña maestra; para cambiarla o generar otro código de recuperación la pide otra vez aunque la bóveda esté abierta. Tras 3 fallos la bóveda se bloquea 1 min, luego 2, 4, 8... hasta 24 h (también con intentos simultáneos). Un respaldo viejo no sirve para entrar con una contraseña o código ya reemplazados. Solo puede *agregar* credenciales. |
| Secretos que quedan en el chat | Tus mensajes con contraseñas, PIN, CSV o fotos de QR se borran al llegar. Lo que revela secretos se autodestruye (60 s por defecto; `.` lo borra ya). Los borrados pendientes sobreviven a reinicios. |
| Cambian datos en la base | Cada secreto está ligado a su credencial y campo (AAD): no se pueden intercambiar entre filas. |
| Bot en un grupo / desconocidos | Solo responde a `AUTHORIZED_TELEGRAM_USER_ID`, solo en chat privado, y a los demás no les contesta nada. |

Lo que **no** está cifrado: los nombres de servicio, usuarios y categorías. Así puedes navegar y
buscar con la bóveda cerrada. Los respaldos sí cifran también esos datos.

> Telegram no es cifrado de extremo a extremo en chats normales: lo que escribes pasa por sus
> servidores aunque el bot lo borre al instante. En la mini app, la contraseña maestra va directo
> a tu servidor por HTTPS y no pasa por el chat.

## Instalación

1. Copia `.env.example` a `.env` y llena los valores. `VAULT_MASTER_KEY` debe ser largo y aleatorio:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. Instala dependencias, genera Prisma y aplica las migraciones:

   ```bash
   npm install
   npm run prisma:generate
   npm run prisma:deploy
   ```

3. Crea el bot con `@BotFather`, pon el token en `TELEGRAM_BOT_TOKEN`, deja vacío
   `AUTHORIZED_TELEGRAM_USER_ID`, arranca (`npm run dev`) y mándale un mensaje: te dirá tu user id.
   Ponlo en `.env` y reinicia.
4. Escríbele al bot: te pedirá crear tu **contraseña maestra** y te dará un **código de
   recuperación**. Anótalo en papel.

### Si vienes de la versión anterior

Aplica la migración (`npm run prisma:deploy`) y, al configurar tu contraseña maestra, el bot pasa
tus credenciales al nuevo cifrado automáticamente. **No cambies `VAULT_MASTER_KEY`**: lo necesita
para leer los datos viejos. El PIN (`MASTER_PIN`) ya no se usa.

## Uso

Escribe el nombre de un servicio para buscarlo, o usa el menú (`menu`). Comandos:

| Comando | Qué hace |
| --- | --- |
| `/menu` | Menú con botones |
| `/buscar netflix` | Buscar (o simplemente escribe `netflix`) |
| `/nueva` | Guardar una credencial |
| `/generar 24` | Generar una contraseña |
| `/salud` | Revisar filtradas, repetidas, débiles y viejas |
| `/respaldo` | Recibir un respaldo cifrado |
| `/actividad` | Actividad reciente |
| `/bloquear` | Cerrar la bóveda ya |
| `/ajustes` | Cambiar contraseña maestra, nuevo código de recuperación, importar |
| `cancelar` | Salir del paso actual |
| `.` | Borrar ya todos los mensajes con secretos |

Siguen funcionando los atajos de siempre: `1` / `categorias`, `2` / `crear`, `3` / `ver categoria`.

- **Importar:** exporta CSV desde tu navegador o gestor y mándalo al bot como archivo.
- **Restaurar:** manda el `.json` de un respaldo. Funciona sobre la misma bóveda (agrega lo que
  falte) o sobre una base de datos vacía. Si el servidor nuevo tiene otro `VAULT_MASTER_KEY`, usa
  tu código de recuperación.
- **Olvidé la contraseña maestra:** botón "Olvidé mi contraseña" → código de recuperación →
  contraseña nueva. Te da un código de recuperación nuevo.

## Mini app (opcional)

Necesita que el servidor sea accesible por HTTPS. Pon en `WEBAPP_URL` la dirección pública
terminada en `/app/` (por ejemplo `https://mi-boveda.example.com/app/`) y reinicia: aparece el botón
"Bóveda" junto al chat y "📱 Abrir app" en el menú.

Para probarla desde tu PC sin desplegar puedes usar un túnel, por ejemplo
`cloudflared tunnel --url http://localhost:3000`, y poner la URL que te da (más `/app/`).

## Desplegar 24/7

**Docker** (cualquier VPS, Render, Railway, Fly.io...). La imagen aplica las migraciones al arrancar:

```bash
docker build -t account-controller .
docker run -d --env-file .env -p 3000:3000 --restart unless-stopped account-controller
```

**Docker Compose** con su propio PostgreSQL:

```bash
POSTGRES_PASSWORD=algo-largo docker compose up -d --build
```

`GET /health` responde 200 si la base de datos contesta (incluye si el polling de Telegram está
vivo) y sirve como health check.

## Desarrollo

```bash
npm run dev     # con recarga
npm run lint    # tipos (código y pruebas)
npm test        # pruebas
npm run check   # lint + pruebas + build
```

Las pruebas usan una base de datos en memoria. Con `TEST_DATABASE_URL` apuntando a un PostgreSQL
migrado, las de punta a punta corren también contra Prisma, como en CI:

```bash
TEST_DATABASE_URL=postgresql://... npx tsx --test --test-concurrency=1 test/store.contract.test.ts test/bot.test.ts test/api.test.ts
```

### Estructura

```
src/
  vault/      cifrado, llaves, credenciales, 2FA, búsqueda, salud, importar, respaldos
  bot/        conversaciones, vistas (texto + botones) y enrutador
  telegram/   cliente de la Bot API, polling y autodestrucción de mensajes
  web/        servidor, API de la mini app y validación de Telegram initData
  db/         interfaz Store e implementación con Prisma
public/app/   mini app (HTML/CSS/JS sin build)
test/         pruebas unitarias, de punta a punta y de contrato
```
