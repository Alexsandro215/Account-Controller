import { z } from "zod";

export const webhookMessageSchema = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            messages: z.array(
              z.object({
                from: z.string(),
                id: z.string(),
                timestamp: z.string(),
                type: z.string(),
                text: z.object({ body: z.string() }).optional()
              })
            ).optional()
          })
        })
      )
    })
  )
});

export type IncomingTextMessage = {
  from: string;
  text: string;
};

export function extractTextMessages(payload: unknown): IncomingTextMessage[] {
  const parsed = webhookMessageSchema.safeParse(payload);

  if (!parsed.success) {
    return [];
  }

  return parsed.data.entry.flatMap((entry) =>
    entry.changes.flatMap((change) =>
      change.value.messages
        ?.filter((message) => message.type === "text" && message.text?.body)
        .map((message) => ({
          from: message.from,
          text: message.text?.body ?? ""
        })) ?? []
    )
  );
}
