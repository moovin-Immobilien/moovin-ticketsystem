import "server-only";
import { env } from "./env";
import { audit } from "./audit";

export type OutMail = { to: string; subject: string; text: string; inReplyTo?: string | null; references?: string | null; messageId: string; ticketId: number };

/** Versand. Ohne POSTMARK_SERVER_TOKEN wird nur simuliert (Prototyp). */
export async function sendMail(m: OutMail): Promise<"gesendet" | "simuliert" | "fehler"> {
  const token = env.postmarkToken();
  if (!token) {
    await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "simuliert" }, m.ticketId);
    return "simuliert";
  }
  const headers = [{ Name: "Message-ID", Value: m.messageId }];
  if (m.inReplyTo) headers.push({ Name: "In-Reply-To", Value: m.inReplyTo });
  if (m.references) headers.push({ Name: "References", Value: m.references });
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": token },
    body: JSON.stringify({ From: env.fromAddress(), To: m.to, Subject: m.subject, TextBody: m.text, Headers: headers, MessageStream: "outbound" }),
  });
  const ok = res.ok;
  await audit("system", "mail_out", { to: m.to, subject: m.subject, mode: "postmark", status: res.status }, m.ticketId);
  return ok ? "gesendet" : "fehler";
}
