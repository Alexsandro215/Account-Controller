// Multi-step conversations ("type your master password", "what is the service?"...).
// Kept in memory on purpose: nothing secret is stored here except while a step is pending.

export type CreateDraft = {
  category?: string;
  service?: string;
  email?: string;
};

export type EditField = "service" | "email" | "category" | "password" | "notes" | "totp";

export type ConversationInput =
  | { type: "setup"; step: "password" }
  | { type: "setup"; step: "confirm"; firstHash: string }
  /** `then` is the button action to run once the vault is open. */
  | { type: "unlock"; then?: string }
  | { type: "recovery" }
  /** Re-entering the current master password before changing it or rotating the recovery code. */
  | { type: "confirmMaster"; then: "chm" | "rot" }
  | { type: "newMaster"; step: "password"; reason: "recovery" | "change" }
  | { type: "newMaster"; step: "confirm"; reason: "recovery" | "change"; firstHash: string }
  | { type: "create"; step: "category" | "service" | "email" | "password"; draft: CreateDraft }
  | { type: "edit"; id: string; field: EditField }
  | { type: "search" }
  /** A backup file is waiting for the master password or recovery code that opens it. */
  | { type: "restore"; backup: string };

export type Conversation = ConversationInput & { expiresAt: number };

// Long enough to look up a password in another app; short enough that a forgotten
// flow does not wait forever for a secret.
const ttlMs = 5 * 60_000;
// For this long after expiring, the bot still remembers what you were doing so it can
// tell you the flow timed out (and delete your message if it was a secret).
const expiredGraceMs = 12 * 60 * 60_000;

const conversations = new Map<string, Conversation>();

export function setConversation(userId: string, conversation: ConversationInput, now = Date.now()): void {
  conversations.set(userId, { ...conversation, expiresAt: now + ttlMs });
}

export function getConversation(userId: string, now = Date.now()): Conversation | undefined {
  const conversation = conversations.get(userId);

  if (!conversation || now > conversation.expiresAt) {
    return undefined;
  }

  return conversation;
}

/** Returns (and forgets) a conversation that expired recently, so the bot can explain. */
export function takeExpiredConversation(userId: string, now = Date.now()): Conversation | undefined {
  const conversation = conversations.get(userId);

  if (!conversation || now <= conversation.expiresAt) {
    return undefined;
  }

  conversations.delete(userId);
  return now - conversation.expiresAt <= expiredGraceMs ? conversation : undefined;
}

export function clearConversation(userId: string): void {
  conversations.delete(userId);
}

/** True when the message the user sends at this step is a secret that must be deleted. */
export function expectsSecret(conversation: ConversationInput | undefined): boolean {
  if (!conversation) {
    return false;
  }

  switch (conversation.type) {
    case "setup":
    case "unlock":
    case "recovery":
    case "confirmMaster":
    case "newMaster":
    case "restore":
      return true;
    case "create":
      return conversation.step === "password";
    case "edit":
      return conversation.field === "password" || conversation.field === "notes" || conversation.field === "totp";
    default:
      return false;
  }
}
