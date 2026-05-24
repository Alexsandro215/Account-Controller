# Account Controller

MVP de una boveda personal para pedir y guardar credenciales por Telegram.

## Stack

- Node.js + TypeScript
- Express
- Telegram Bot API
- PostgreSQL en Neon/Supabase
- Prisma
- AES-256-GCM para cifrar contrasenas antes de guardarlas

## Setup

1. Copia `.env.example` a `.env` y llena los valores.
2. Instala dependencias:

```bash
npm install
```

3. Genera Prisma y corre migraciones:

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. Crea un bot en Telegram con `@BotFather` y copia el token en:

```env
TELEGRAM_BOT_TOKEN="..."
```

5. Deja `AUTHORIZED_TELEGRAM_USER_ID` vacio la primera vez, arranca el bot y mandale cualquier mensaje. El bot te dira tu user id.

6. Copia ese id en `AUTHORIZED_TELEGRAM_USER_ID` y reinicia:

```bash
npm run dev
```

## Telegram

El bot usa long polling, asi que no necesitas ngrok ni webhook publico.

- Salud: `GET /health`
- Token: `TELEGRAM_BOT_TOKEN`
- Usuario autorizado: `AUTHORIZED_TELEGRAM_USER_ID`

## Comandos MVP

- `menu`
- `categorias`
- `crear`
- `ver categoria`

El bot solo ejecuta comandos para el usuario configurado en `AUTHORIZED_TELEGRAM_USER_ID`.
