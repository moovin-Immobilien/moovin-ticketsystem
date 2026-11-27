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

// Ticket-Intelligenz im Demo-Modus: Stichwortregeln statt Claude (der Server bestätigt die Signale wie sonst auch)
function demoSignals(text: string, intent: Intent, hasAttachments: boolean): { type: string; evidence: string; deadline: string }[] {
  const out: { type: string; evidence: string; deadline: string }[] = [];
  const hit = (type: string, re: RegExp, deadline = "") => { const m = text.match(re); if (m) out.push({ type, evidence: m[0].slice(0, 100), deadline }); };
  if (hasAttachments) out.push({ type: "unterlagen_eingegangen", evidence: "Anhang", deadline: "" });
  hit("zusage_nach_besichtigung", /(wohnung (sehr )?gerne (nehmen|anmieten)|möchten? (die wohnung )?(gerne )?anmieten|wir nehmen die wohnung|would like to (take|rent) the (flat|apartment))/i);
  hit("vertragsphase", /(mietvertrag|mietangebot|kaution|unterschrift|unterschreiben|schlüsselübergabe|lease agreement|deposit)/i);
  const dm = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  const deadline = dm ? `${dm[3] ?? new Date().getFullYear()}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}` : "";
  hit("konkurrenz_frist", /(andere(n|s)? (zusage|angebot)|(muss|müssen) (mich|uns) bis [^.!?\n]{1,30} entscheiden|entscheid\w* bis|frist bis)/i, deadline);
  if (/(heute|morgen)/i.test(text)) hit("termin_bald", /(termin|besichtigung)[^.!?\n]{0,60}(heute|morgen)|(heute|morgen)[^.!?\n]{0,60}(termin|besichtigung)/i);
  if (intent === "rueckzug") hit("rueckzug_spaet", /(nach der besichtigung|doch nicht|vor dem vertrag)/i);
  hit("eskalation", /(zum (dritten|wiederholten|x-ten) mal|anwalt|mieterverein|verbraucherzentrale|bewertung)/i);
  if (intent === "sonstiges" && !hasAttachments && !/\?/.test(text) && text.replace(/\s+/g, " ").length < 220)
    hit("kein_handlungsbedarf", /(vielen dank|danke(schön)?|thank you|thanks|abwesen|out of office|automatische antwort|lesebestätigung)[^\n]{0,60}/i);
  return out;
}

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
  let awaits = false;
  // Mehrere offene Termine, nicht eindeutig → Rückfrage statt Terminaktion
  const ambiguous = !res.id && "reason" in res && res.reason.startsWith("Mehrere");
  const askWhich = () => {
    const list = (ctx?.applications ?? []).filter((x) => x.appointment && ["eingeladen", "bestaetigt"].includes(x.appointment.status) && new Date(x.appointment.starts_at) > new Date())
      .map((x) => `- ${fmt(x.appointment!.starts_at)}: ${x.object_title}`).join("\n");
    awaits = true; conf = 0.75;
    return `vielen Dank für Ihre Nachricht. Sie haben derzeit mehrere Besichtigungstermine:\n${list}\n\nBitte teilen Sie uns kurz mit, welchen Termin Sie meinen.`;
  };

  const signals = demoSignals(`${i.subject}\n${i.newMessage}`, intent, i.attachments.length > 0);
  const nothingToDo = signals.some((x) => x.type === "kein_handlungsbedarf");
  const general = ["spam", "nicht_zustaendig", "beschwerde", "wohnungssuche_allgemein", "konto_datenschutz", "technik_login"].includes(intent);
  const obj = i.crmObject?.title ? ` zur Wohnung ${i.crmObject.title}` : "";
  if (nothingToDo) {
    body = ""; reason = ""; conf = 0.8;
  } else if (i.moovinOff && !ctx && !general) {
    // Livetest ohne moovin: keine Bewerberdaten → neutrale, versandfertige Formulierung (keine Platzhalter), der AM prüft; Aktionen werden Aufgaben (keine moovin-Aufrufe)
    conf = 0.75;
    switch (intent) {
      case "unterlagen_nachreichen":
        if (i.attachments.length) { body = `vielen Dank für Ihre Unterlagen (${i.attachments.map((x) => x.filename).join(", ")}). Wir haben sie entgegengenommen und legen sie in Ihrem Bewerberprofil ab; eine inhaltliche Prüfung können wir an dieser Stelle noch nicht bestätigen.\n\nHinweis: Alle Unterlagen pflegen Sie am einfachsten in Ihrem moovin Login. Bitte stellen Sie sicher, dass dort alle Unterlagen hinterlegt sind.`; act({ type: "dokumente_ablegen", manual: true }); conf = 0.85; }
        else { body = "vielen Dank für Ihre Nachricht. Bitte laden Sie Ihre Unterlagen in Ihrem moovin Profil hoch; dort sehen Sie auch, welche Dokumente noch benötigt werden."; needs = true; reason = "Unterlagen angekündigt, aber keine Anhänge gefunden"; conf = 0.5; }
        break;
      case "termin_bestaetigen":
        body = `vielen Dank für Ihre Rückmeldung. Wir geben Ihre Zusage für den Besichtigungstermin${obj} an Ihren Ansprechpartner weiter.`; act({ type: "termin_bestaetigen", manual: true }); conf = 0.8; break;
      case "termin_absage":
        body = `vielen Dank für Ihre Rückmeldung. Wir geben Ihre Absage für den Besichtigungstermin${obj} an Ihren Ansprechpartner weiter.`; act({ type: "termin_absagen", manual: true }); conf = 0.8; break;
      case "termin_verschieben":
        body = "vielen Dank für Ihre Nachricht. Wir haben Ihren Wunsch, den Termin zu verschieben, an Ihren Ansprechpartner weitergegeben. Er meldet sich mit möglichen Alternativen.";
        act({ type: "termin_verschieben_wunsch", manual: true, text: i.newMessage.slice(0, 300) }); conf = 0.8; break;
      case "interesse_bestaetigen":
        body = "vielen Dank für Ihre Nachricht. Ihren Wunsch, die Wohnung anzumieten, geben wir an den zuständigen Ansprechpartner weiter. Bitte bestätigen Sie Ihr Mietinteresse zusätzlich über den Button in der E-Mail, die Sie nach der Besichtigung erhalten haben – falls Sie das bereits getan haben, ist nichts weiter nötig. Ihr Ansprechpartner meldet sich zu den nächsten Schritten."; act({ type: "interesse_setzen", interest: "interessiert", manual: true }); conf = 0.85; break;
      case "rueckzug":
        body = "vielen Dank für Ihre Rückmeldung. Wir geben Ihren Rückzug an Ihren Ansprechpartner weiter. Wir wünschen Ihnen alles Gute bei der Wohnungssuche.";
        act({ type: "interesse_setzen", interest: "zurueckgezogen", manual: true }); conf = 0.88; break;
      case "besichtigung_frage":
        body = `vielen Dank für Ihre Frage${obj}. Datum, Uhrzeit und Treffpunkt Ihrer Besichtigung finden Sie in Ihrer Einladungs-E-Mail und in Ihrem moovin Profil. Bitte kommen Sie pünktlich zum dort genannten Treffpunkt.`; needs = true; reason = "moovin-Anbindung aus: Termin bitte in moovin nachsehen"; break;
      case "bewerbungsstatus":
        body = `vielen Dank für Ihre Nachricht${obj}. Haben Sie Ihr Interesse an der Wohnung nach der Besichtigung über den Button in der E-Mail, die Sie nach der Besichtigung erhalten haben, bereits bestätigt? Dies ist Voraussetzung für den weiteren Prozess. Bitte prüfen Sie Ihren moovin Login, hier erscheinen alle notwendigen nächsten Schritte und Sie können den Stand der Bewerbung einsehen.`; needs = true; reason = "moovin-Anbindung aus: Stand bitte in moovin nachsehen"; break;
      case "objekt_frage": {
        const hits = await i.tools.searchKnowledge(text);
        body = hits.length ? `vielen Dank für Ihre Frage. ${hits[0].body}` : `vielen Dank für Ihre Frage${obj}. Ihr Ansprechpartner meldet sich dazu bei Ihnen.`;
        needs = !hits.length; reason = needs ? "Keine passende Info in der Wissensdatenbank" : ""; conf = hits.length ? 0.7 : 0.3; break;
      }
      default:
        body = "vielen Dank für Ihre Nachricht. Ihr Ansprechpartner meldet sich dazu bei Ihnen."; needs = true; reason = "Anliegen nicht eindeutig"; conf = 0.3;
    }
  } else if (!ctx && !general) {
    body = "vielen Dank für Ihre Nachricht. Leider können wir Ihre Mailadresse keiner Bewerbung zuordnen. Bitte schreiben Sie uns von der Adresse, mit der Sie sich beworben haben, oder nennen Sie uns Objekt und Namen, unter dem die Bewerbung erfolgt ist.";
    conf = 0.7;
  } else switch (intent) {
    case "bewerbungsstatus":
      body = `vielen Dank für Ihre Nachricht zur Wohnung „${app?.object_title}“. ${app?.status_label} ${app?.next_step ?? ""}`;
      if (app?.missing_documents.length) body += `\n\nFolgende Unterlagen fehlen noch:\n- ${app.missing_documents.join("\n- ")}\n\nBitte laden Sie diese in Ihrem moovin Profil hoch.`;
      conf = 0.9; break;
    case "unterlagen_nachreichen":
      body = `vielen Dank, wir haben Ihre Unterlagen erhalten (${i.attachments.map((x) => x.filename).join(", ") || "ohne Anhang"}) und in Ihrem Bewerberprofil abgelegt. Eine inhaltliche Prüfung können wir an dieser Stelle noch nicht bestätigen.`;
      if (!i.attachments.length) { needs = true; reason = "Unterlagen angekündigt, aber keine Anhänge gefunden"; conf = 0.5; }
      if (ctx && i.attachments.length) act({ type: "dokumente_ablegen" });
      conf = Math.min(conf, 0.88); break;
    case "termin_absage":
      if (appt) { body = `vielen Dank für Ihre Rückmeldung. Wir haben Ihren Besichtigungstermin am ${fmt(appt.starts_at)} storniert und den Platz freigegeben.`; act({ type: "termin_absagen", appointment_id: appt.id }); conf = 0.9; }
      else if (ambiguous) body = askWhich();
      else { body = "vielen Dank für Ihre Nachricht. Wir geben Ihre Absage an Ihren Ansprechpartner weiter."; needs = true; reason = "Kein offener Termin gefunden"; conf = 0.4; }
      break;
    case "termin_bestaetigen":
      if (appt) { body = `vielen Dank für Ihre Rückmeldung. Wir haben Ihre Teilnahme am Besichtigungstermin am ${fmt(appt.starts_at)} bestätigt. Treffpunkt: ${appt.meeting_point}. Bitte bringen Sie einen Lichtbildausweis mit.`; act({ type: "termin_bestaetigen", appointment_id: appt.id }); conf = 0.9; }
      else if (ambiguous) body = askWhich();
      else { body = "vielen Dank für Ihre Rückmeldung. Wir geben Ihre Zusage an Ihren Ansprechpartner weiter."; needs = true; reason = "Kein offener Termin gefunden"; conf = 0.4; }
      break;
    case "termin_verschieben":
      if (appt) { body = `vielen Dank für Ihre Nachricht. Wir haben Ihren Wunsch, den Termin am ${fmt(appt.starts_at)} zu verschieben, an Ihren Ansprechpartner weitergegeben. Er meldet sich mit möglichen Alternativen. Bitte beachten Sie, dass Ersatztermine bei Sammelbesichtigungen nur begrenzt möglich sind.`; act({ type: "termin_verschieben_wunsch", appointment_id: appt.id, text: i.newMessage.slice(0, 300) }); conf = 0.8; }
      else if (ambiguous) body = askWhich();
      else { body = "vielen Dank für Ihre Nachricht. Wir geben Ihren Wunsch, den Termin zu verschieben, an Ihren Ansprechpartner weiter. Er meldet sich mit möglichen Alternativen."; needs = true; reason = "Kein Termin gefunden"; conf = 0.4; }
      break;
    case "besichtigung_frage":
      body = appt ? `Ihr Besichtigungstermin ist am ${fmt(appt.starts_at)}. Treffpunkt: ${appt.meeting_point}. Bitte bringen Sie einen Lichtbildausweis mit.` : "vielen Dank für Ihre Frage. Datum, Uhrzeit und Treffpunkt Ihrer Besichtigung finden Sie in Ihrer Einladungs-E-Mail und in Ihrem moovin Profil.";
      if (!appt) { needs = true; reason = "Kein Termin gefunden"; }
      conf = appt ? 0.85 : 0.4; break;
    case "objekt_frage": {
      const hits = await i.tools.searchKnowledge(text);
      body = hits.length ? `vielen Dank für Ihre Frage. ${hits[0].body}` : "vielen Dank für Ihre Frage. Ihr Ansprechpartner meldet sich dazu bei Ihnen.";
      needs = !hits.length; reason = needs ? "Keine passende Info in der Wissensdatenbank" : ""; conf = hits.length ? 0.7 : 0.3; break;
    }
    case "interesse_bestaetigen":
      body = "vielen Dank, wir haben Ihr Interesse vermerkt und melden uns, sobald der Eigentümer entschieden hat.";
      if (app) act({ type: "interesse_setzen", application_id: app.id, interest: "interessiert" }); conf = 0.85; break;
    case "rueckzug":
      body = "vielen Dank für Ihre Rückmeldung. Wir haben vermerkt, dass Sie Ihre Bewerbung zurückziehen. Wir wünschen Ihnen alles Gute bei der Wohnungssuche.";
      if (app) act({ type: "interesse_setzen", application_id: app.id, interest: "zurueckgezogen" }); conf = 0.88; break;
    case "beschwerde":
      body = "vielen Dank für Ihre Nachricht. Es tut uns leid, dass Sie unzufrieden sind. Ihr Ansprechpartner meldet sich persönlich bei Ihnen."; needs = true; reason = "Beschwerde"; conf = 0.6; break;
    case "nicht_zustaendig":
      body = "vielen Dank für Ihre Nachricht. Für Anliegen zu bestehenden Mietverhältnissen ist die jeweilige Hausverwaltung zuständig; die Kontaktdaten finden Sie in Ihrem Mietvertrag."; needs = true; reason = "Kein Interessenten-Anliegen"; conf = 0.6; break;
    case "wohnungssuche_allgemein":
    case "konto_datenschutz":
    case "technik_login": {
      const q = intent === "wohnungssuche_allgemein" ? "Wohnung finden bewerben Suchagent" : intent === "konto_datenschutz" ? "Konto Daten löschen Datenschutz" : text;
      const hits = await i.tools.searchKnowledge(q);
      body = hits.length ? `vielen Dank für Ihre Nachricht. ${hits[0].body.replace(/\s*Quelle:.*$/, "")}` : "vielen Dank für Ihre Nachricht. Ihr Ansprechpartner meldet sich dazu bei Ihnen.";
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
      body = "vielen Dank für Ihre Nachricht. Ihr Ansprechpartner meldet sich dazu bei Ihnen."; needs = true; reason = "Anliegen nicht eindeutig"; conf = 0.3;
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
    awaits_reply: awaits,
    signals,
  };
  return { result, model: "demo-regeln", usage: null, toolCalls: [] };
}
