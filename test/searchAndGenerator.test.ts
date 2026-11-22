import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePassword, passwordStrength } from "../src/vault/generator.js";
import { editDistance, searchCredentials } from "../src/vault/search.js";

const items = [
  { service: "Netflix", email: "yo@gmail.com", category: "Streaming" },
  { service: "Gmail", email: "yo@gmail.com", category: "Correo" },
  { service: "BBVA México", email: "1234", category: "Bancos" },
  { service: "Banamex", email: "yo", category: "Bancos" },
  { service: "Amazon Prime Video", email: "yo@outlook.com", category: "Streaming" }
];

const services = (query: string) => searchCredentials(items, query).map((item) => item.service);

describe("searchCredentials", () => {
  it("ranks an exact service first", () => {
    assert.equal(services("gmail")[0], "Gmail");
  });

  it("ignores accents and case", () => {
    assert.deepEqual(services("MEXICO"), ["BBVA México"]);
  });

  it("matches categories and words inside the service", () => {
    assert.deepEqual(services("bancos").sort((a, b) => a.localeCompare(b, "es")), ["Banamex", "BBVA México"]);
    assert.deepEqual(services("prime"), ["Amazon Prime Video"]);
  });

  it("tolerates typos", () => {
    assert.equal(services("netflx")[0], "Netflix");
    assert.equal(services("nteflix")[0], "Netflix");
  });

  it("requires every word to match", () => {
    assert.deepEqual(services("streaming amazon"), ["Amazon Prime Video"]);
    assert.deepEqual(services("zzzz"), []);
  });

  it("computes transposition-aware edit distance", () => {
    assert.equal(editDistance("abcd", "abdc"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
  });
});

describe("generatePassword", () => {
  it("honors length and always includes every character class", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword({ length: 12 });
      assert.equal(password.length, 12);
      assert.match(password, /[a-z]/);
      assert.match(password, /[A-Z]/);
      assert.match(password, /[2-9]/);
      assert.match(password, /[!@#$%^&*\-_=+?]/);
      assert.doesNotMatch(password, /[lIO01]/, "no ambiguous characters");
    }
  });

  it("can skip symbols and clamps silly lengths", () => {
    assert.match(generatePassword({ length: 30, symbols: false }), /^[A-Za-z2-9]{30}$/);
    assert.equal(generatePassword({ length: 3 }).length, 8);
    assert.equal(generatePassword({ length: 10_000 }).length, 128);
  });
});

describe("passwordStrength", () => {
  it("flags common and predictable passwords", () => {
    assert.equal(passwordStrength("123456").score, 0);
    assert.equal(passwordStrength("Password1").score, 0);
    assert.ok(passwordStrength("Netflix2020").score <= 1);
    assert.ok(passwordStrength("aaaaaaaaaaaa").score <= 1);
    assert.ok(passwordStrength("mariposa!").score <= 1);
  });

  it("does not punish long passphrases", () => {
    assert.ok(passwordStrength("caballo bateria grapa correcta").score >= 3);
  });

  it("rates generated passwords as strong", () => {
    assert.equal(passwordStrength(generatePassword({ length: 20 })).score, 4);
  });
});
