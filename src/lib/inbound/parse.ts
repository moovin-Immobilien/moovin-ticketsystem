// Normalisiert eingehende Mails. Adapter für Postmark Inbound (JSON). Anderer Anbieter → neuen Adapter schreiben.
export type InboundAttachment = { filename: string; contentType: string; contentBase64: string; size: number };
export type InboundMail = {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  authResults: string | null;
  attachments: InboundAttachment[];
};

type PostmarkHeader = { Name: string; Value: string };
type PostmarkInbound = {
  FromFull?: { Email?: string; Name?: string };
  From?: string;
  FromName?: string;
  To?: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  StrippedTextReply?: string;
  HtmlBody?: string;
  MessageID?: string;
  Headers?: PostmarkHeader[];
  Attachments?: { Name: string; Content: string; ContentType: string; ContentLength: number }[];
};

function header(h: PostmarkHeader[] | undefined, name: string): string | null {
  const all = (h ?? []).filter((x) => x.Name.toLowerCase() === name.toLowerCase()).map((x) => x.Value);
  return all.length ? all.join("\n") : null;
}

function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
}

export function parsePostmark(p: PostmarkInbound): InboundMail {
  const fromEmail = (p.FromFull?.Email ?? p.From ?? "").trim().toLowerCase();
  const text = (p.TextBody && p.TextBody.trim()) || (p.HtmlBody ? htmlToText(p.HtmlBody) : "");
  return {
    fromEmail,
    fromName: (p.FromFull?.Name ?? p.FromName ?? "").trim(),
    to: (p.OriginalRecipient ?? p.To ?? "").toLowerCase(),
    subject: (p.Subject ?? "").trim(),
    text: text.slice(0, 50_000),
    messageId: header(p.Headers, "Message-ID") ?? (p.MessageID ? `<${p.MessageID}>` : null),
    inReplyTo: header(p.Headers, "In-Reply-To"),
    references: header(p.Headers, "References"),
    authResults: header(p.Headers, "Authentication-Results") ?? header(p.Headers, "ARC-Authentication-Results"),
    attachments: (p.Attachments ?? []).map((a) => ({ filename: a.Name, contentType: a.ContentType, contentBase64: a.Content, size: a.ContentLength })),
  };
}

/** Entfernt zitierte Vorgänger-Mails grob, damit Claude nur die neue Nachricht sieht (Verlauf kommt separat). */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const l of lines) {
    if (/^\s*(Am .+ schrieb .+:|On .+ wrote:|-----\s*(Original|Ursprüngliche) (Message|Nachricht)\s*-----|Von:\s.+|From:\s.+@)/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join("\n").trim() || text.trim();
}
