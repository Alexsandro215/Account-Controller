import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeQrFromJpeg } from "../src/vault/qr.js";
import { jpeg, qrJpeg } from "./support/qr.js";

describe("decodeQrFromJpeg", () => {
  it("reads the otpauth URI from a QR photo", () => {
    const uri = "otpauth://totp/GitHub:yo%40mail.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    assert.equal(decodeQrFromJpeg(qrJpeg(uri)), uri);
  });

  it("returns null for a photo without a QR code", () => {
    const blank = jpeg.encode({ data: Buffer.alloc(64 * 64 * 4, 200), width: 64, height: 64 }, 80).data;
    assert.equal(decodeQrFromJpeg(blank), null);
  });
});
