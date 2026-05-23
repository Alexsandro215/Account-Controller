import { config } from "../config.js";

type WhatsAppTextResponse = {
  messages?: Array<{ id: string }>;
};

export async function sendText(to: string, body: string): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body
        }
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WhatsApp send failed: ${response.status} ${detail}`);
  }

  await response.json() as WhatsAppTextResponse;
}
