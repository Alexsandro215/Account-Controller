import express from "express";
import { config } from "./config.js";
import { webhookRouter } from "./whatsapp/webhook.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/webhook", webhookRouter);

app.listen(config.PORT, () => {
  console.log(`Account Controller listening on port ${config.PORT}`);
});
