# Account Controller

MVP de una bóveda personal para pedir y guardar credenciales por WhatsApp.

## Stack

- Node.js + TypeScript
- Express
- WhatsApp Cloud API
- PostgreSQL en Neon/Supabase
- Prisma
- AES-256-GCM para cifrar contraseñas antes de guardarlas

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

4. Arranca el bot:

```bash
npm run dev
```

## WhatsApp webhook

- Verificacion: `GET /webhook`
- Mensajes entrantes: `POST /webhook`
- Salud: `GET /health`

En desarrollo local puedes exponer el puerto con ngrok y registrar la URL en Meta:

```bash
ngrok http 3000
```

## Comandos MVP

- `menu`
- `guardar`
- `buscar netflix`
- `categorias`

El bot solo responde al numero configurado en `AUTHORIZED_PHONE`.
