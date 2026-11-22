import * as jsQRModule from "jsqr";
import * as jpegModule from "jpeg-js";

// jsqr and jpeg-js are CommonJS; normalize their default export under ESM/NodeNext.
type JsQr = typeof import("jsqr").default;
const jsQR: JsQr = ((jsQRModule as unknown as { default?: JsQr }).default ?? jsQRModule) as JsQr;
const jpeg = ((jpegModule as unknown as { default?: typeof jpegModule }).default ?? jpegModule) as typeof jpegModule;

/** Reads the text of a QR code in a JPEG photo (what Telegram sends for photos), or null. */
export function decodeQrFromJpeg(buffer: Buffer): string | null {
  const image = jpeg.decode(buffer, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: 40,
    maxMemoryUsageInMB: 256
  });
  const pixels = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength);

  return jsQR(pixels, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}
