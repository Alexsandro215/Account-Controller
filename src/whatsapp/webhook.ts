import { Router } from "express";
import { config } from "../config.js";
import { handleBotMessage } from "../bot/flows.js";
import { isAuthorizedPhone } from "../security/auth.js";
import { sendText } from "./client.js";
import { extractTextMessages } from "./types.js";

export const webhookRouter = Router();

webhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === config.WHATSAPP_VERIFY_TOKEN && typeof challenge === "string") {
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

webhookRouter.post("/", async (req, res) => {
  res.sendStatus(200);

  const messages = extractTextMessages(req.body);

  for (const message of messages) {
    if (!isAuthorizedPhone(message.from)) {
      continue;
    }

    try {
      const reply = await handleBotMessage(message.from, message.text);
      await sendText(message.from, reply);
    } catch (error) {
      console.error("Bot error", error);
      await sendText(message.from, "Hubo un error procesando tu mensaje.");
    }
  }
});
