// Demo-Modus ohne API-Key: einfache Regeln statt Claude, damit Oberfläche und Abläufe testbar sind.
import type { AgentInput, AgentOutput, AgentResult, ProposedAction } from "./types";
import type { Intent } from "../intents";
import { resolveAppointment } from "../appointments";

const RULES: [Intent, RegExp][] = [
  ["spam", /(seo|backlinks|crypto|gewinnspiel|viagra|unsubscribe)/i],
  ["beschwerde", /(beschwer|unverschämt|frechheit|anwalt|unzufrieden|complain)/i],
  ["konto_datenschutz", /(konto löschen|account löschen|daten löschen|löschung meiner|datenschutz|dsgvo|newsletter abmelden|delete my (account|data))/i],
  ["technik_login", /(passwort|login|einloggen|anmelden geht nicht|fehlermeldung|lädt nicht|nect|selbstauskunft funktioniert)/i],
  ["nicht_zustaendig", /(heizung|schimmel|nebenkostenabrechnung|mangel|meine wohnung .* defekt|hausverwaltung)/i],
  ["rueckzug", /(zurückziehen|kein interesse mehr|ziehe .* zurück|anderweitig fündig|withdraw)/i],
  ["termin_verschieben", /(verschieben|anderen termin|später kommen|reschedule|other (time|date))/i],
  ["termin_absage", /(absag|sagen sie .* ab|nicht .{0,40}(kommen|teilnehmen)|schaffe es nicht|cancel)/i],
  ["termin_bestaetigen", /(ich komme|komme gerne|nehme (gerne )?teil|bestätige|bin dabei|zusage|i will (attend|come)|confirm)/i],
  ["unterlagen_nachreichen", /(anbei|im anhang|unterlagen|nachweis|schufa|attached|documents)/i],
  ["interesse_bestaetigen", /(weiterhin interesse|interesse bestätigen|möchte die wohnung|still interested)/i],
  ["besichtigung_frage", /(besichtigung|treffpunkt|wo treffen|viewing)/i],
  ["bewerbungsstatus", /(stand|status|rückmeldung|gibt es neuigkeiten|wann .* entscheid|any news)/i],
  ["objekt_frage", /(haustier|hund|katze|stellplatz|parken|balkon|küche|aufzug|wbs|miete|pet|parking)/i],
];

function fmt(d: string) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

export async function runDemoAgent(i: AgentInput): Promise<AgentOutput> {
  const text = `${i.subject}\n${i.newMessage}`;
  const en = /\b(dear|hello|hi|thanks|regards|please)\b/i.test(text) && !/\b(und|bitte|danke)\b/i.test(text);
  let intent: Intent = (RULES.find(([, re]) => re.test(text))?.[0]) ?? "sonstiges";
  if (i.attachments.length && intent === "sonstiges") intent = "unterlagen_nachreichen";
  const ctx = i.context;
  const a = ctx?.applicant;
  const res = resolveAppointment(ctx, i.subject, i.newMessage);
  const app = ctx?.applications.find((x) => res.id && x.appointment?.id === res.id) ?? ctx?.applications[0];
  const appt = res.id ? app?.appointment ?? null : null;
  const greet = en ? (a ? `Dear ${a.salutation === "Frau" ? "Ms" : "Mr"} ${a.last_name},` : "Hello,") : a ? `Guten Tag ${a.salutation ? a.salutation + " " : ""}${a.last_name},` : "Guten Tag,";
  const bye = en ? "Kind regards\nYour moovin letting team" : "Viele Grüße\nIhr moovin Vermietungsteam";
  const actions: ProposedAction[] = [];
  const act = (p: Partial<ProposedAction> & { type: ProposedAction["type"] }) => actions.push({ application_id: "", appointment_id: "", interest: "", text: "", ...p });
  let body = "";
  let needs = false;
  let reason = "";
  let conf = 0.8;

  if (!ctx && !["spam", "nicht_zustaendig", "beschwerde", "wohnungssuche_allgemein", "konto_datenschutz", "technik_login"].includes(intent)) {
    body = "vielen Dank für Ihre Nachricht. Leider können wir Ihre Mailadresse keiner Bewerbung zuordnen. Bitte schreiben Sie uns von der Adresse, mit der Sie sich beworben haben, oder nennen Sie uns Objekt und Namen, unter dem die Bewerbung erfolgt ist.";
    conf = 0.7;
  } else switch (intent) {
    case "bewerbungsstatus":
      body = `vielen Dank für Ihre Nachricht zur Wohnung „${app?.object_title}“. ${app?.status_label} ${app?.next_step ?? ""}`;
      if (app?.missing_documents.length) body += `\n\nFolgende Unterlagen fehlen noch:\n- ${app.missing_documents.join("\n- ")}\n\nSie können diese einfach als Antwort auf diese Mail senden.`;
      conf = 0.9; break;
    case "unterlagen_nachreichen":
      body = `vielen Dank, wir haben Ihre Unterlagen erhalten (${i.attachments.map((x) => x.filename).join(", ") || "ohne Anhang"}) und in Ihrem Bewerberprofil abgelegt. Wir prüfen sie in der Regel innerhalb von 1–2 Werktagen.`;
      if (!i.attachments.length) { needs = true; reason = "Unterlagen angekündigt, aber keine Anhänge gefunden"; conf = 0.5; }
      if (ctx && i.attachments.length) act({ type: "dokumente_ablegen" });
      conf = Math.min(conf, 0.88); break;
    case "termin_absage":
      if (appt) { body = `vielen Dank für Ihre Rückmeldung. Wir haben Ihren Besichtigungstermin am ${fmt(appt.starts_at)} storniert und den Platz freigegeben.`; act({ type: "termin_absagen", appointment_id: appt.id }); conf = 0.9; }
      else { body = "vielen Dank für Ihre Nachricht. Wir konnten keinen offenen Termin finden. [AM: bitte prüfen]"; needs = true; reason = "Kein offener Termin gefunden"; conf = 0.4; }
      break;
    case "termin_bestaetigen":
      if (appt) { body = `vielen Dank für Ihre Rückmeldung. Wir haben Ihre Teilnahme am Besichtigungstermin am ${fmt(appt.starts_at)} bestätigt. Treffpunkt: ${appt.meeting_point}. Bitte bringen Sie einen Lichtbildausweis mit.`; act({ type: "termin_bestaetigen", appointment_id: appt.id }); conf = 0.9; }
      else { body = "vielen Dank für Ihre Rückmeldung. [AM: kein offener Termin gefunden]"; needs = true; reason = "Kein offener Termin gefunden"; conf = 0.4; }
      break;
    case "termin_verschieben":
      if (appt) { body = `vielen Dank für Ihre Nachricht. Wir haben Ihren Wunsch, den Termin am ${fmt(appt.starts_at)} zu verschieben, an Ihren Ansprechpartner weitergegeben. Er meldet sich mit möglichen Alternativen. Bitte beachten Sie, dass Ersatztermine bei Sammelbesichtigungen nur begrenzt möglich sind.`; act({ type: "termin_verschieben_wunsch", appointment_id: appt.id, text: i.newMessage.slice(0, 300) }); conf = 0.8; }
      else { body = "vielen Dank für Ihre Nachricht. [AM: kein Termin gefunden]"; needs = true; reason = "Kein Termin gefunden"; conf = 0.4; }
      break;
    case "besichtigung_frage":
      body = appt ? `Ihr Besichtigungstermin ist am ${fmt(appt.starts_at)}. Treffpunkt: ${appt.meeting_point}. Bitte bringen Sie einen Lichtbildausweis mit.` : "vielen Dank für Ihre Frage. [AM: bitte ergänzen]";
      if (!appt) { needs = true; reason = "Kein Termin gefunden"; }
      conf = appt ? 0.85 : 0.4; break;
    case "objekt_frage": {
      const hits = await i.tools.searchKnowledge(text);
      body = hits.length ? `vielen Dank für Ihre Frage. ${hits[0].body}` : "vielen Dank für Ihre Frage. [AM: bitte beantworten]";
      needs = !hits.length; reason = needs ? "Keine passende Info in der Wissensdatenbank" : ""; conf = hits.length ? 0.7 : 0.3; break;
    }
    case "interesse_bestaetigen":
      body = "vielen Dank, wir haben Ihr Interesse vermerkt und melden uns, sobald der Eigentümer entschieden hat.";
      if (app) act({ type: "interesse_setzen", application_id: app.id, interest: "interessiert" }); conf = 0.85; break;
    case "rueckzug":
      body = "vielen Dank für Ihre Rückmeldung. Wir haben vermerkt, dass Sie Ihre Bewerbung zurückziehen. Wir wünschen Ihnen alles Gute bei der Wohnungssuche.";
      if (app) act({ type: "interesse_setzen", application_id: app.id, interest: "zurueckgezogen" }); conf = 0.88; break;
    case "beschwerde":
      body = "vielen Dank für Ihre Nachricht. Es tut uns leid, dass Sie unzufrieden sind. [AM: bitte persönlich antworten]"; needs = true; reason = "Beschwerde"; conf = 0.6; break;
    case "nicht_zustaendig":
      body = "vielen Dank für Ihre Nachricht. Für Anliegen zu bestehenden Mietverhältnissen ist die jeweilige Hausverwaltung zuständig. [AM: Ansprechpartner ergänzen]"; needs = true; reason = "Kein Interessenten-Anliegen"; conf = 0.6; break;
    case "wohnungssuche_allgemein":
    case "konto_datenschutz":
    case "technik_login": {
      const q = intent === "wohnungssuche_allgemein" ? "Wohnung finden bewerben Suchagent" : intent === "konto_datenschutz" ? "Konto Daten löschen Datenschutz" : text;
      const hits = await i.tools.searchKnowledge(q);
      body = hits.length ? `vielen Dank für Ihre Nachricht. ${hits[0].body.replace(/\s*Quelle:.*$/, "")}` : "vielen Dank für Ihre Nachricht. [AM: bitte beantworten]";
      needs = !hits.length; reason = needs ? "Keine passende Info in der Wissensdatenbank" : ""; conf = hits.length ? 0.75 : 0.3;
      if (intent === "konto_datenschutz") {
        body = "vielen Dank für Ihre Nachricht. Wir haben Ihre Anfrage an unser Datenschutzteam weitergeleitet. Es bearbeitet sie und meldet sich bei Ihnen. Bitte beachten Sie, dass laufende Bewerbungen mit der Löschung enden.";
        act({ type: "datenschutz_weiterleiten", text: "Datenschutzanfrage per Mail" }); needs = false; reason = ""; conf = 0.85;
      }
      break;
    }
    case "spam":
      body = ""; needs = true; reason = "Vermutlich Spam – ohne Antwort schließen"; conf = 0.7; break;
    default:
      body = "vielen Dank für Ihre Nachricht. [AM: bitte beantworten]"; needs = true; reason = "Anliegen nicht eindeutig"; conf = 0.3;
  }

  const result: AgentResult = {
    intent,
    language: en ? "en" : "de",
    confidence: conf,
    summary: `Demo-Modus (ohne Claude): Anliegen per Stichwort erkannt als „${intent}“.`,
    reply_text: body ? `${greet}\n\n${body}\n\n${bye}` : "",
    actions,
    needs_human: needs,
    needs_human_reason: reason,
  };
  return { result, model: "demo-regeln", usage: null, toolCalls: [] };
}
