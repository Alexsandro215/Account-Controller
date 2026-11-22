import * as jpegModule from "jpeg-js";
import QRCode from "qrcode";

export const jpeg = ((jpegModule as unknown as { default?: typeof jpegModule }).default ?? jpegModule) as typeof jpegModule;

/** Renders text as a QR code photo, like the one a user would send to the bot. */
export function qrJpeg(text: string, scale = 8, margin = 4): Buffer {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = (modules.size + margin * 2) * scale;
  const data = Buffer.alloc(size * size * 4, 255);

  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue;

      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const offset = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4;
          data[offset] = data[offset + 1] = data[offset + 2] = 0;
        }
      }
    }
  }

  return jpeg.encode({ data, width: size, height: size }, 85).data;
}
