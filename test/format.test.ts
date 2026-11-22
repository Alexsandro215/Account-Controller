import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, splitMessage } from "../src/telegram/format.js";

describe("escapeHtml", () => {
  it("escapes the characters Telegram's HTML mode cares about", () => {
    assert.equal(escapeHtml("a<b>&c"), "a&lt;b&gt;&amp;c");
  });

  it("leaves passwords with quotes and symbols readable", () => {
    assert.equal(escapeHtml(`p@ss"'w0rd!`), `p@ss"'w0rd!`);
  });
});

describe("splitMessage", () => {
  it("returns short messages untouched", () => {
    assert.deepEqual(splitMessage("hola\nmundo", 100), ["hola\nmundo"]);
  });

  it("cuts at line breaks and never exceeds the limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `linea ${i} <code>secreto${i}</code>`);
    const chunks = splitMessage(lines.join("\n"), 120);

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`);
      // Every <code> opened in a chunk is closed in the same chunk.
      assert.equal(chunk.split("<code>").length, chunk.split("</code>").length);
    }
    assert.equal(chunks.join("\n"), lines.join("\n"));
  });

  it("hard-splits a single line longer than the limit without breaking emoji", () => {
    const line = "🔑".repeat(30);
    const chunks = splitMessage(line, 10);

    for (const chunk of chunks) {
      assert.ok(chunk.length <= 10);
      assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    assert.equal(chunks.join(""), line);
  });
});
