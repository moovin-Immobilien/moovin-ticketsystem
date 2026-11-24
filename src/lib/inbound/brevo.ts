import "server-only";
import { env } from "../env";
import type { InboundMail } from "./parse";

const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES = 20;

/** Lädt Brevo-Anhänge über den DownloadToken (GET /v3/inbound/attachments/{token}). Fehler → Anhang ohne Inhalt, Ticket geht an Menschen. */
export async function loadBrevoAttachments(mail: InboundMail): Promise<{ mail: InboundMail; failed: string[] }> {
  const failed: string[] = [];
  const out = [];
  for (const a of mail.attachments.slice(0, MAX_FILES)) {
    if (!a.downloadToken || a.contentBase64) { out.push(a); continue; }
    try {
      if (!env.brevoApiKey()) throw new Error("BREVO_API_KEY fehlt");
      if (a.size > MAX_FILE) throw new Error("zu groß");
      const res = await fetch(`${env.brevoApiBase()}/v3/inbound/attachments/${encodeURIComponent(a.downloadToken)}`, {
        headers: { "api-key": env.brevoApiKey(), Accept: "application/octet-stream" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE) throw new Error("zu groß");
      out.push({ ...a, contentBase64: buf.toString("base64"), size: buf.length, downloadToken: undefined });
    } catch (e) {
      failed.push(`${a.filename}: ${(e as Error).message}`);
    }
  }
  if (mail.attachments.length > MAX_FILES) failed.push(`${mail.attachments.length - MAX_FILES} weitere Anhänge nicht übernommen`);
  return { mail: { ...mail, attachments: out }, failed };
}
