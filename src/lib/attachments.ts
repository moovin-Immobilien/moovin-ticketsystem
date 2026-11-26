/**
 * Anhänge sicher ausliefern: Der Dateityp wird am Inhalt erkannt (erste Bytes), nicht an der Angabe des Absenders.
 * Vorschau nur für PDF und gängige Bilder; Office-Dateien nur als Download; alles andere (Programme, Archive,
 * HTML/SVG, Dateien mit Makros, Unbekanntes) ist gesperrt.
 */

export type AttachmentKind = "pdf" | "image" | "office" | "blocked";

export type AttachmentClass = {
  kind: AttachmentKind;
  /** Content-Type, mit dem die Datei ausgeliefert wird (nie der vom Absender angegebene). */
  mime: string;
  /** Darf im Browser als Vorschau geöffnet werden. */
  preview: boolean;
  /** Grund bei gesperrten Dateien (für die Anzeige im Ticket). */
  reason?: string;
};

const MACRO_EXT = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|ppsm|sldm)$/i;
const OFFICE_ZIP: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};
const OFFICE_OLE: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel" };

function startsWith(b: Uint8Array, sig: number[], offset = 0) {
  if (b.length < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function extOf(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

/** Erkennt den Typ anhand der ersten Bytes (16 reichen) und der Dateiendung. */
export function classifyAttachment(filename: string, head: Uint8Array): AttachmentClass {
  const ext = extOf(filename);
  const blocked = (reason: string): AttachmentClass => ({ kind: "blocked", mime: "application/octet-stream", preview: false, reason });

  if (MACRO_EXT.test(filename)) return blocked("Office-Datei mit Makros");
  if (startsWith(head, ascii("%PDF-"))) return { kind: "pdf", mime: "application/pdf", preview: true };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", preview: true };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png", preview: true };
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return { kind: "image", mime: "image/gif", preview: true };
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return { kind: "image", mime: "image/webp", preview: true };
  // HEIC/HEIF (iPhone-Fotos): Browser zeigen sie meist nicht an → nur Download
  if (startsWith(head, ascii("ftyp"), 4) && ["heic", "heix", "hevc", "heif", "mif1", "msf1"].some((b) => startsWith(head, ascii(b), 8)))
    return { kind: "image", mime: "image/heic", preview: false };
  // Word/Excel neu (ZIP-Container) – nur mit passender Endung, sonst ist es ein beliebiges Archiv
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (OFFICE_ZIP[ext]) return { kind: "office", mime: OFFICE_ZIP[ext], preview: false };
    return blocked("Archiv (ZIP)");
  }
  // Word/Excel alt (OLE)
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (OFFICE_OLE[ext]) return { kind: "office", mime: OFFICE_OLE[ext], preview: false };
    return blocked("Unbekannte Office-Datei");
  }
  if (startsWith(head, ascii("MZ")) || startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return blocked("Programmdatei");
  return blocked("Dateityp nicht erlaubt");
}

/** Dateiname für Content-Disposition: ASCII-Fallback plus UTF-8 (RFC 5987), ohne Steuerzeichen und Anführungszeichen. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const clean = filename.replace(/[\u0000-\u001f\u007f"\\/]/g, "_").slice(0, 150) || "anhang";
  const fallback = clean.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_");
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
