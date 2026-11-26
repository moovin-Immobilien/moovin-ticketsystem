import "server-only";
import { env } from "./env";

/**
 * Fester Mailfuß für Antworten an Bewerber (wie die übliche moovin-Signatur).
 * Wird beim Versand angehängt – nicht im Entwurf und nicht in ticket.messages gespeichert.
 * Bewusst KEINE Kontaktdaten (Telefon, Mail, Website): Interessenten sind nur schriftlich über mieter@ erreichbar.
 * Verlinkt sind nur Hilfecenter (FAQ), Datenschutz und die Social-Icons.
 */

export const FAQ_URL = "https://help.moovin.de/portal/de/kb/faqs-mietinteressen-innen";
export const DATENSCHUTZ_URL = "https://www.moovin.de/datenschutzerklaerung";
const LINKEDIN_URL = "https://www.linkedin.com/company/moovinimmobilien";
const INSTAGRAM_URL = "https://www.instagram.com/moovin_de/";
// Gleiche Icons wie in der Gmail-Signatur der moovin-Mitarbeitenden
const ICON = (n: string) => `https://cdn2.hubspot.net/hubfs/53/tools/email-signature-generator/icons/${n}-icon-dark-2x.png`;

const NAVY = "rgb(0,30,70)";
const GREY = "rgb(102,102,102)";

const T = {
  de: {
    faqText: "Antworten auf häufige Fragen finden Sie in unserem Hilfecenter:",
    faqHtml: (a: string) => `Antworten auf häufige Fragen finden Sie in unserem ${a}.`,
    faqLink: "Hilfecenter",
    gf: "Geschäftsführer: Fabian Mellin",
    court: "Amtsgericht Hamburg",
    privacyText: "Hinweise zur Datenverarbeitung:",
    privacyHtml: (a: string) => `Hinweise zur Datenverarbeitung finden Sie ${a}.`,
    privacyLink: "hier",
  },
  en: {
    faqText: "Answers to frequently asked questions can be found in our help center:",
    faqHtml: (a: string) => `Answers to frequently asked questions can be found in our ${a}.`,
    faqLink: "help center",
    gf: "Managing Director: Fabian Mellin",
    court: "Local Court Hamburg",
    privacyText: "Information on data processing:",
    privacyHtml: (a: string) => `Information on data processing can be found ${a}.`,
    privacyLink: "here",
  },
} as const;

export type SignatureLang = keyof typeof T;
export const signatureLang = (language: string | null | undefined): SignatureLang =>
  !language || /^de/i.test(language) ? "de" : "en";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function signatureText(lang: SignatureLang): string {
  const t = T[lang];
  return [
    t.faqText,
    FAQ_URL,
    "",
    "moovin Immobilien GmbH · Sternstraße 121, 20357 Hamburg",
    `${t.gf} · ${t.court}, HRB 136082`,
    "",
    `${t.privacyText} ${DATENSCHUTZ_URL}`,
  ].join("\n");
}

export function signatureHtml(lang: SignatureLang): string {
  const t = T[lang];
  const link = (href: string, text: string) => `<a href="${href}" target="_blank" style="color:${NAVY};text-decoration:underline">${esc(text)}</a>`;
  const icon = (href: string, name: string) =>
    `<a href="${href}" target="_blank" style="display:inline-block;margin-left:6px"><img src="${ICON(name)}" alt="${name}" width="24" height="24" style="display:block;border:0;width:24px;height:24px"></a>`;
  const small = `font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:${GREY}`;
  return `
<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#222;margin:16px 0 0">${t.faqHtml(link(FAQ_URL, t.faqLink))}</p>
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:20px;width:100%;max-width:500px;border-collapse:collapse">
  <tr><td colspan="2" style="border-top:1px solid ${NAVY};font-size:0;line-height:0;height:24px">&nbsp;</td></tr>
  <tr>
    <td style="vertical-align:top"><img src="${env.appUrl()}/mail/moovin-signatur.png" alt="moovin – Real estate. Really easy." width="131" height="50" style="display:block;border:0;width:131px;height:50px"></td>
    <td style="vertical-align:top;text-align:right;white-space:nowrap">${icon(LINKEDIN_URL, "linkedin")}${icon(INSTAGRAM_URL, "instagram")}</td>
  </tr>
  <tr><td colspan="2" style="${small};padding-top:16px">
    moovin Immobilien GmbH · Sternstraße 121, 20357 Hamburg<br>
    ${esc(t.gf)}<br>
    ${esc(t.court)}<br>
    HRB: 136082
  </td></tr>
  <tr><td colspan="2" style="${small};padding-top:14px">${t.privacyHtml(link(DATENSCHUTZ_URL, t.privacyLink))}</td></tr>
</table>`;
}

/** Antworttext (reiner Text aus Entwurf/AM) + Mailfuß → Text- und HTML-Fassung für den Versand. */
export function withSignature(body: string, language: string | null | undefined): { text: string; html: string } {
  const lang = signatureLang(language);
  const text = `${body.trimEnd()}\n\n${signatureText(lang)}`;
  const bodyHtml = esc(body.trimEnd()).replace(/\r?\n/g, "<br>");
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#222">${bodyHtml}</div>${signatureHtml(lang)}
</body></html>`;
  return { text, html };
}
