// Normalisiert eingehende Mails. Adapter für Brevo Inbound Parsing und Postmark Inbound (beide JSON).
// Brevo liefert Anhänge nicht im Webhook, sondern als DownloadToken → werden danach per API geladen (lib/inbound/brevo.ts).
export type InboundAttachment = { filename: string; contentType: string; contentBase64: string; size: number; downloadToken?: string };
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

// ---------- Brevo ----------
type BrevoMailbox = { Address?: string; Name?: string | null };
type BrevoItem = {
  MessageId?: string;
  InReplyTo?: string | null;
  From?: BrevoMailbox;
  To?: BrevoMailbox[];
  Recipients?: BrevoMailbox[];
  Subject?: string;
  RawTextBody?: string | null;
  RawHtmlBody?: string | null;
  ExtractedMarkdownMessage?: string | null;
  Headers?: Record<string, string | string[]>;
  Attachments?: { Name: string; ContentType: string; ContentLength: number; ContentID?: string; DownloadToken: string }[];
};

function brevoHeader(h: Record<string, string | string[]> | undefined, name: string): string | null {
  if (!h) return null;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  if (!key) return null;
  const v = h[key];
  return Array.isArray(v) ? v.join("\n") : v;
}

const angle = (id: string | null | undefined) => (id ? (id.trim().startsWith("<") ? id.trim() : `<${id.trim()}>`) : null);

export function parseBrevo(payload: { items?: BrevoItem[] }): InboundMail[] {
  return (payload.items ?? []).map((p) => {
    const text = (p.RawTextBody && p.RawTextBody.trim()) || (p.RawHtmlBody ? htmlToText(p.RawHtmlBody) : "") || (p.ExtractedMarkdownMessage ?? "");
    const inbound = (p.Recipients?.[0]?.Address ?? p.To?.[0]?.Address ?? "").toLowerCase();
    return {
      fromEmail: (p.From?.Address ?? "").trim().toLowerCase(),
      fromName: (p.From?.Name ?? "").trim(),
      to: inbound,
      subject: (p.Subject ?? "").trim(),
      text: text.slice(0, 50_000),
      messageId: angle(brevoHeader(p.Headers, "Message-ID") ?? p.MessageId),
      inReplyTo: brevoHeader(p.Headers, "In-Reply-To") ?? angle(p.InReplyTo),
      references: brevoHeader(p.Headers, "References"),
      authResults: brevoHeader(p.Headers, "Authentication-Results") ?? brevoHeader(p.Headers, "ARC-Authentication-Results"),
      // Inline-Bilder (ContentID, z. B. Signatur-Logos) sind keine Unterlagen
      attachments: (p.Attachments ?? []).filter((a) => !a.ContentID || !/^image\//i.test(a.ContentType))
        .map((a) => ({ filename: a.Name, contentType: a.ContentType, contentBase64: "", size: a.ContentLength, downloadToken: a.DownloadToken })),
    };
  });
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
