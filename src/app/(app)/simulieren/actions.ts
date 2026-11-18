"use server";
import { redirect } from "next/navigation";
import { randomBytes } from "node:crypto";
import { requireAgent } from "@/lib/auth";
import { processInbound } from "@/lib/pipeline";
import type { InboundMail } from "@/lib/inbound/parse";

// Kleines Test-PDF als Anhang (Inhalt egal – wird nie an Claude gegeben)
const DUMMY_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");

export async function simulateAction(form: FormData) {
  const agent = await requireAgent();
  const from = String(form.get("from") ?? "").trim().toLowerCase();
  const verified = form.get("verified") === "on";
  const attach = form.get("attach") === "on";
  const mail: InboundMail = {
    fromEmail: from,
    fromName: String(form.get("name") ?? ""),
    to: "mieter@moovin.de",
    subject: String(form.get("subject") ?? ""),
    text: String(form.get("body") ?? ""),
    messageId: `<sim-${randomBytes(6).toString("hex")}@test.local>`,
    inReplyTo: null,
    references: null,
    authResults: verified ? `inbound.test; dkim=pass header.d=${from.split("@")[1]}; spf=pass; dmarc=pass` : `inbound.test; dkim=none; spf=softfail; dmarc=fail`,
    attachments: attach
      ? [
          { filename: "Gehaltsnachweise_Aug-Okt.pdf", contentType: "application/pdf", contentBase64: DUMMY_PDF, size: 52_000 },
          { filename: "Mietschuldenfreiheit.pdf", contentType: "application/pdf", contentBase64: DUMMY_PDF, size: 31_000 },
        ]
      : [],
  };
  const { ticketId } = await processInbound(mail, `am:${agent.email}`);
  redirect(`/tickets/${ticketId}`);
}
