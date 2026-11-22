import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearConversation,
  expectsSecret,
  getConversation,
  setConversation,
  takeExpiredConversation,
  type ConversationInput
} from "../src/bot/sessions.js";

const MINUTE = 60_000;

describe("conversations", () => {
  it("stay alive for 5 minutes", () => {
    setConversation("u1", { type: "search" }, 0);

    assert.equal(getConversation("u1", 4 * MINUTE)?.type, "search");
    assert.equal(getConversation("u1", 6 * MINUTE), undefined);
    clearConversation("u1");
  });

  it("remember a recently expired step once, to explain the timeout", () => {
    setConversation("u2", { type: "create", step: "password", draft: { category: "Bancos", email: "a@b.c" } }, 0);

    assert.equal(takeExpiredConversation("u2", 2 * MINUTE), undefined, "not expired yet");

    const expired = takeExpiredConversation("u2", 10 * MINUTE);
    assert.equal(expired?.type, "create");
    assert.equal(expectsSecret(expired), true);
    assert.equal(takeExpiredConversation("u2", 10 * MINUTE), undefined, "only reported once");
  });

  it("forget steps that expired long ago", () => {
    setConversation("u3", { type: "unlock" }, 0);
    assert.equal(takeExpiredConversation("u3", 13 * 60 * MINUTE), undefined);
  });

  it("flag exactly the steps where the user types a secret", () => {
    const cases: [ConversationInput, boolean][] = [
      [{ type: "setup", step: "password" }, true],
      [{ type: "setup", step: "confirm", firstHash: "x" }, true],
      [{ type: "unlock" }, true],
      [{ type: "recovery" }, true],
      [{ type: "confirmMaster", then: "chm" }, true],
      [{ type: "newMaster", step: "password", reason: "change" }, true],
      [{ type: "restore", backup: "{}" }, true],
      [{ type: "create", step: "category", draft: {} }, false],
      [{ type: "create", step: "email", draft: {} }, false],
      [{ type: "create", step: "password", draft: {} }, true],
      [{ type: "edit", id: "x", field: "service" }, false],
      [{ type: "edit", id: "x", field: "password" }, true],
      [{ type: "edit", id: "x", field: "notes" }, true],
      [{ type: "edit", id: "x", field: "totp" }, true],
      [{ type: "search" }, false]
    ];

    for (const [conversation, secret] of cases) {
      assert.equal(expectsSecret(conversation), secret, JSON.stringify(conversation));
    }
  });
});
