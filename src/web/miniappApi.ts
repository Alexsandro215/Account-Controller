import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import { isAuthorizedTelegramUser } from "../security/auth.js";
import {
  createCredential,
  currentTotp,
  deleteCredential,
  getCredential,
  listCredentials,
  revealSecrets,
  updateCredential,
  type CredentialSummary,
  type CredentialUpdate
} from "../vault/credentials.js";
import { isVaultError } from "../vault/errors.js";
import { generatePassword } from "../vault/generator.js";
import { isVaultReady } from "../vault/keys.js";
import { attemptUnlock, currentLock, isUnlocked, lockVault, unlockExpiresAt } from "../vault/unlock.js";
import { audit } from "../vault/audit.js";
import { validateInitData } from "./telegramAuth.js";

// JSON API for the Mini App (public/app). Every request carries Telegram's signed init data
// in `Authorization: tma <initData>`; only the authorized Telegram user gets through. The
// master password travels over HTTPS straight to this server, never through the chat.

type AuthedRequest = Request & { telegramUserId?: string };

export function miniappApi(): express.Router {
  const router = express.Router();

  router.use(express.json({ limit: "64kb" }));
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(authenticate);

  router.get(
    "/state",
    handler(async (req, res) => {
      const lockedUntil = await currentLock(userOf(req));
      res.json({
        vaultReady: await isVaultReady(),
        unlocked: isUnlocked(),
        unlockExpiresAt: unlockExpiresAt()?.toISOString() ?? null,
        lockedUntil: lockedUntil?.toISOString() ?? null
      });
    })
  );

  router.post(
    "/unlock",
    handler(async (req, res) => {
      await requireReady();
      const password = typeof req.body?.password === "string" ? req.body.password : "";

      if (password === "") {
        res.status(400).json({ error: "invalid", message: "Escribe tu contraseña maestra." });
        return;
      }

      // Recovery codes are only accepted in the chat, where the follow-up flow lives.
      const result = await attemptUnlock(userOf(req), password, false);

      if (result.ok) {
        res.json({ unlocked: true, unlockExpiresAt: result.expiresAt.toISOString() });
      } else if (result.reason === "locked" || result.lockedUntil) {
        const until = result.reason === "locked" ? result.lockedUntil : result.lockedUntil!;
        res.status(429).json({ error: "too_many_attempts", lockedUntil: until.toISOString() });
      } else {
        res.status(403).json({ error: "wrong_password", remainingAttempts: result.remainingAttempts });
      }
    })
  );

  router.post(
    "/lock",
    handler(async (_req, res) => {
      lockVault();
      await audit("lock", null, "app");
      res.json({ unlocked: false });
    })
  );

  router.get(
    "/credentials",
    handler(async (_req, res) => {
      await requireReady();
      res.json({ items: (await listCredentials()).map(toItem) });
    })
  );

  router.post(
    "/credentials",
    handler(async (req, res) => {
      await requireReady();
      const body = req.body ?? {};
      const item = await createCredential({
        category: text(body.category),
        service: text(body.service),
        email: text(body.email),
        password: text(body.password),
        notes: optionalText(body.notes),
        totp: optionalText(body.totp)
      });
      res.status(201).json({ item: toItem(item) });
    })
  );

  router.patch(
    "/credentials/:id",
    handler(async (req, res) => {
      await requireReady();
      const body = req.body ?? {};
      const update: CredentialUpdate = {};

      for (const field of ["category", "service", "email", "password"] as const) {
        if (typeof body[field] === "string") update[field] = body[field];
      }

      for (const field of ["notes", "totp"] as const) {
        if (body[field] === null || typeof body[field] === "string") update[field] = body[field];
      }

      res.json({ item: toItem(await updateCredential(String(req.params.id), update)) });
    })
  );

  router.delete(
    "/credentials/:id",
    handler(async (req, res) => {
      await requireReady();
      await deleteCredential(String(req.params.id));
      res.json({ ok: true });
    })
  );

  router.post(
    "/credentials/:id/reveal",
    handler(async (req, res) => {
      await requireReady();
      const { password, notes } = await revealSecrets(String(req.params.id));
      res.json({ password, notes });
    })
  );

  router.post(
    "/credentials/:id/totp",
    handler(async (req, res) => {
      await requireReady();
      await getCredential(String(req.params.id));
      const { code, remainingSeconds, period } = await currentTotp(String(req.params.id));
      res.json({ code, remainingSeconds, period });
    })
  );

  router.post(
    "/generate",
    handler(async (req, res) => {
      const length = Number(req.body?.length ?? 20);
      const symbols = req.body?.symbols !== false;
      res.json({ password: generatePassword({ length: Number.isFinite(length) ? length : 20, symbols }) });
    })
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}

function authenticate(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.get("authorization") ?? "";
  const initData = header.startsWith("tma ") ? header.slice(4) : "";
  const validated = initData ? validateInitData(initData, config.TELEGRAM_BOT_TOKEN) : null;

  if (!validated || !isAuthorizedTelegramUser(validated.userId)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  req.telegramUserId = validated.userId;
  next();
}

function userOf(req: Request): string {
  return (req as AuthedRequest).telegramUserId!;
}

async function requireReady(): Promise<void> {
  if (!(await isVaultReady())) {
    throw Object.assign(new Error("vault_not_ready"), { status: 409, body: { error: "vault_not_ready" } });
  }
}

/** Maps vault errors to the HTTP contract the frontend expects. */
function handler(run: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await run(req, res);
    } catch (error) {
      const withStatus = error as { status?: number; body?: unknown };

      if (withStatus.status && withStatus.body) {
        res.status(withStatus.status).json(withStatus.body);
        return;
      }

      if (isVaultError(error)) {
        const status = { vault_not_ready: 409, vault_locked: 423, not_found: 404, invalid: 400, no_totp: 409 }[error.code];
        res.status(status).json({ error: error.code, message: error.message });
        return;
      }

      console.error("Mini App API error", error);
      res.status(500).json({ error: "internal" });
    }
  };
}

function toItem(credential: CredentialSummary) {
  return {
    id: credential.id,
    service: credential.service,
    email: credential.email,
    category: credential.category,
    hasTotp: credential.hasTotp,
    hasNotes: credential.hasNotes,
    passwordChangedAt: credential.passwordChangedAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString()
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
