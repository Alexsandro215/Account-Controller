import express from "express";
import { config } from "./config.js";
import { startTelegramPolling } from "./telegram/polling.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(config.PORT, () => {
  console.log(`Account Controller listening on port ${config.PORT}`);
});

startTelegramPolling().catch((error) => {
  console.error("Telegram polling stopped", error);
  process.exitCode = 1;
});
