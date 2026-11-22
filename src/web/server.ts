import express from "express";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { lastSuccessfulPoll } from "../telegram/polling.js";
import { miniappApi } from "./miniappApi.js";

// public/ sits next to src/ and dist/, so this resolves the same in dev (tsx) and prod.
const publicDir = fileURLToPath(new URL("../../public/app/", import.meta.url));

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // Telegram Web shows Mini Apps in an iframe.
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
].join("; ");

export function createServer(options: { miniApp?: boolean } = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  /** 200 when the database answers and Telegram polling is alive; 503 otherwise. */
  app.get("/health", async (_req, res) => {
    let database = true;

    try {
      await db().ping();
    } catch {
      database = false;
    }

    const lastPoll = lastSuccessfulPoll();
    const polling = lastPoll !== undefined && Date.now() - lastPoll.getTime() < 2 * 60_000;
    res.status(database ? 200 : 503).json({ ok: database, database, polling });
  });

  if (options.miniApp ?? config.WEBAPP_URL !== "") {
    app.use("/api", miniappApi());
    // The app's relative asset URLs need the trailing slash.
    app.get("/app", (req, res, next) => {
      if (req.originalUrl.split("?")[0] === "/app") {
        res.redirect(301, "/app/");
      } else {
        next();
      }
    });
    app.use(
      "/app",
      (_req, res, next) => {
        res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
        res.setHeader("Cache-Control", "no-cache");
        next();
      },
      express.static(publicDir, { index: "index.html", redirect: true })
    );
  }

  return app;
}
