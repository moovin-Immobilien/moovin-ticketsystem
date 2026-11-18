import { NextRequest, NextResponse, after } from "next/server";
import { timingSafeEqual, createHash } from "node:crypto";
import { env } from "@/lib/env";
import { parsePostmark } from "@/lib/inbound/parse";
import { processInbound } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function tokenOk(given: string | null) {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(env.inboundToken()).digest();
  return timingSafeEqual(a, b);
}

/** Inbound-Webhook (Postmark-Format). Token per ?token= oder Basic-Auth-Passwort. Antwortet sofort, verarbeitet danach. */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  let token = url.searchParams.get("token");
  const auth = req.headers.get("authorization");
  if (!token && auth?.startsWith("Basic ")) token = Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":");
  if (!tokenOk(token)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 35 * 1024 * 1024) return NextResponse.json({ error: "zu groß" }, { status: 413 });

  let mail;
  try { mail = parsePostmark(await req.json()); } catch { return NextResponse.json({ error: "ungültiges JSON" }, { status: 400 }); }
  if (!mail.fromEmail) return NextResponse.json({ error: "Absender fehlt" }, { status: 400 });

  after(async () => {
    try { await processInbound(mail, "webhook"); } catch (e) { console.error("inbound processing failed", e); }
  });
  return NextResponse.json({ ok: true });
}
