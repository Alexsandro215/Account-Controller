import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CredentialSummary } from "../src/vault/credentials.js";
import { buildHealthReport } from "../src/vault/health.js";
import { parseRange, pwnedCounts, sha1Hex } from "../src/vault/hibp.js";
import { importCsv, parseCsv } from "../src/vault/importers.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, commas and newlines inside fields, CRLF and BOM", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n');
    assert.deepEqual(rows, [
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "multi\nline"]
    ]);
  });
});

describe("importCsv", () => {
  it("reads a Chrome export", () => {
    const csv = "name,url,username,password,note\nNetflix,https://www.netflix.com/login,yo@mail.com,pa,ss\n,https://www.github.com,dev,gh,\n";
    const result = importCsv(csv);

    assert.equal(result.format, "Chrome/Edge");
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items[0], {
      category: "Importadas",
      service: "Netflix",
      email: "yo@mail.com",
      password: "pa",
      notes: "ss\nSitio: https://www.netflix.com/login",
      totp: null
    });
    assert.equal(result.items[1].service, "github.com", "falls back to the site's hostname");
  });

  it("reads a Bitwarden export with folders and 2FA, skipping non-logins", () => {
    const csv = [
      "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
      "Bancos,,login,BBVA,,,,https://bbva.mx,cliente,secreto,JBSWY3DPEHPK3PXP",
      ",,note,Nota segura,texto,,,,,,",
      "Correo,,login,Gmail,,,,,yo@gmail.com,,"
    ].join("\n");
    const result = importCsv(csv);

    assert.equal(result.format, "Bitwarden");
    assert.equal(result.items.length, 1);
    assert.equal(result.skipped, 2, "the secure note and the login without password");
    assert.equal(result.items[0].category, "Bancos");
    assert.equal(result.items[0].totp, "JBSWY3DPEHPK3PXP");
  });

  it("reads a Firefox export", () => {
    const csv = '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://accounts.spotify.com","yo","pw","","","{x}","1","1","1"';
    const result = importCsv(csv);
    assert.equal(result.format, "Firefox");
    assert.equal(result.items[0].service, "accounts.spotify.com");
  });

  it("refuses files without a password column", () => {
    assert.throws(() => importCsv("a,b\n1,2"), /contraseñas/);
  });
});

describe("Pwned Passwords", () => {
  it("only sends the first 5 characters of each hash and matches locally", async () => {
    const requested: string[] = [];
    const hash = sha1Hex("password");
    const fakeFetch = async (url: string) => {
      requested.push(url);
      const body = url.endsWith(hash.slice(0, 5)) ? `${hash.slice(5)}:3861493\r\nABCDEF0123456789ABCDEF0123456789ABC:0` : "";
      return new Response(body, { status: 200 });
    };

    const counts = await pwnedCounts(["password", "a-much-better-one"], fakeFetch);

    assert.equal(counts.get("password"), 3861493);
    assert.equal(counts.get("a-much-better-one"), 0);
    assert.ok(requested.every((url) => /\/range\/[0-9A-F]{5}$/.test(url)), "only 5-char prefixes leave the server");
  });

  it("parses range responses including padding", () => {
    assert.equal(parseRange("AAA:0\nBBB:12").get("BBB"), 12);
  });
});

describe("buildHealthReport", () => {
  const summary = (id: string, service: string, changedDaysAgo = 10): CredentialSummary => ({
    id,
    service,
    email: `${id}@mail.com`,
    category: "X",
    aliases: [],
    hasTotp: false,
    hasNotes: false,
    passwordChangedAt: new Date(Date.UTC(2026, 10, 21) - changedDaysAgo * 86_400_000),
    createdAt: new Date(0),
    updatedAt: new Date(0)
  });

  it("finds reused, weak, old and unreadable passwords and scores the vault", async () => {
    const report = await buildHealthReport(
      [
        { credential: summary("a", "A"), password: "Xq9!vR2#mK7$pL4@" },
        { credential: summary("b", "B"), password: "Xq9!vR2#mK7$pL4@" },
        { credential: summary("c", "C"), password: "123456" },
        { credential: summary("d", "D", 800), password: "Zt5^wN8&jH3*cB6%" },
        { credential: summary("e", "E"), password: "Yu4@eM7!kP2#rS9$" },
        { credential: summary("f", "F"), password: null }
      ],
      { checkPwned: false, now: new Date(Date.UTC(2026, 10, 21)) }
    );

    assert.equal(report.pwned, null);
    assert.deepEqual(report.reused.map((group) => group.map((c) => c.id)), [["a", "b"]]);
    assert.deepEqual(report.weak.map((entry) => entry.credential.id), ["c"]);
    assert.deepEqual(report.old.map((entry) => entry.credential.id), ["d"]);
    assert.deepEqual(report.unreadable.map((c) => c.id), ["f"]);
    assert.equal(report.score, 17, "only E (1 of 6) is clean");
  });
});
