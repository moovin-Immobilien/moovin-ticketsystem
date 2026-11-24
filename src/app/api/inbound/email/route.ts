import { NextRequest, NextResponse, after } from "next/server";
import { timingSafeEqual, createHash } from "node:crypto";
import { env } from "@/lib/env";
import { parsePostmark, parseBrevo, type InboundMail } from "@/lib/inbound/parse";
import { loadBrevoAttachments } from "@/lib/inbound/brevo";
import { processInbound } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function tokenOk(given: string | null) {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(env.inboundToken()).digest();
  return timingSafeEqual(a, b);
}

/**
 * Inbound-Webhook. Format je nach MAIL_PROVIDER: "brevo" (Inbound Parsing, { items: [...] }) oder "postmark".
 * Token per ?token=, Basic-Auth-Passwort oder Bearer. Antwortet sofort, verarbeitet danach.
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  let token = url.searchParams.get("token");
  const auth = req.headers.get("authorization");
  if (!token && auth?.startsWith("Basic ")) token = Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":");
  if (!token && auth?.startsWith("Bearer ")) token = auth.slice(7);
  if (!tokenOk(token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 35 * 1024 * 1024) return NextResponse.json({ error: "zu groß" }, { status: 413 });

  let mails: InboundMail[];
  try {
    const body = await req.json();
    mails = env.mailProvider() === "postmark" ? [parsePostmark(body)] : parseBrevo(body);
  } catch {
    return NextResponse.json({ error: "ungültiges JSON" }, { status: 400 });
  }
  mails = mails.filter((m) => m.fromEmail.includes("@"));
  if (!mails.length) return NextResponse.json({ error: "Absender fehlt" }, { status: 400 });

  after(async () => {
    for (const raw of mails) {
      try {
        const { mail, failed } = raw.attachments.some((a) => a.downloadToken) ? await loadBrevoAttachments(raw) : { mail: raw, failed: [] };
        await processInbound(mail, "webhook", failed.length ? [`Anhänge nicht geladen: ${failed.join("; ")}`] : []);
      } catch (e) {
        console.error("inbound processing failed", e);
      }
    }
  });
  return NextResponse.json({ ok: true, received: mails.length });
}
