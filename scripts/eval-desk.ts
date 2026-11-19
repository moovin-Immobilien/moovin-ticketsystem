// Offline-Test: pseudonymisierte echte Desk-Mails durch denselben Prompt + dieselben Werkzeuge.
// Bewerber-Kontext ist ein neutraler Testkontext (echte Bewerber gibt es in der Attrappe nicht).
import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { readFileSync, writeFileSync } from "node:fs";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "../src/lib/ai/prompt";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 3 });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const model = process.env.CLAUDE_MODEL_DRAFT ?? "claude-sonnet-5-5";
const mails = JSON.parse(readFileSync(process.argv[2], "utf8")) as { n: number; subject: string; body: string; created: string }[];
const out = process.argv[3];

const appt = new Date(Date.now() + 3 * 86400_000); appt.setUTCHours(17, 0, 0, 0);
const CTX = {
  hinweis: "TESTKONTEXT: Platzhalterdaten, nicht der echte Stand. Nur für Ton/Anliegen-Erkennung.",
  applicant: { id: "A-TEST", salutation: "", first_name: "[Vorname]", last_name: "[Nachname]" },
  applications: [{ id: "AP-TEST", object_id: "OBJ-TEST", object_title: "[Objekt aus der Mail]", status: "in_pruefung",
    status_label: "Ihre Unterlagen werden geprüft.", missing_documents: [], next_step: "Wir melden uns, sobald die Prüfung abgeschlossen ist.",
    appointment: { id: "AT-TEST", starts_at: appt.toISOString(), kind: "sammelbesichtigung", status: "eingeladen", meeting_point: "[Treffpunkt laut Einladung]" } }],
};
const TOOLS: Anthropic.Tool[] = [
  { name: "get_application_status", description: "Bewerbungen des Absenders (an den Absender gebunden).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_object_info", description: "Objektinfos für Objekte des Absenders.", input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"], additionalProperties: false } },
  { name: "search_knowledge", description: "Durchsucht die moovin-Wissensdatenbank. Stichworte auf Deutsch.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
];
async function kb(q: string) {
  const words = q.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 12);
  const oq = words.length ? words.map((w) => `${w}:*`).join(" | ") : "xxxxxx";
  return sql`select title, body from ticket.knowledge_articles where status='aktiv' and scope='global'
             and (tsv @@ websearch_to_tsquery('german', ${q}) or tsv @@ to_tsquery('german', ${oq})) limit 4`;
}
async function run(m: (typeof mails)[number]) {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content:
    `Heute: Mittwoch, 18. November 2026\nAbsender in moovin bekannt: ja (Testkontext)\nAbsender verifiziert: ja\nAnhänge: keine\n\nNeue Mail – Betreff: ${m.subject}\n<email>\n${m.body}\n</email>\n\nErstelle Analyse und Antwortentwurf gemäß Vorgaben.` }];
  const usage = { i: 0, o: 0, cr: 0, cw: 0 }; const tools: string[] = []; let kbHits = 0;
  for (let t = 0; t < 6; t++) {
    const res = await client.messages.create({ model, max_tokens: 12000, system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS, messages, output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } } });
    usage.i += res.usage.input_tokens; usage.o += res.usage.output_tokens; usage.cr += res.usage.cache_read_input_tokens ?? 0; usage.cw += res.usage.cache_creation_input_tokens ?? 0;
    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue; tools.push(b.name);
        let o: unknown;
        if (b.name === "get_application_status") o = CTX;
        else if (b.name === "get_object_info") o = { info: "Objektdaten im Test nicht verfügbar" };
        else { const h = await kb(String((b.input as Record<string, string>).query ?? "")); kbHits += h.length; o = h; }
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(o) });
      }
      messages.push({ role: "user", content: results }); continue;
    }
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    let result: unknown;
    try { result = JSON.parse(text); } catch {
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: "Deine letzte Ausgabe war kein vollständiges JSON. Gib die Analyse jetzt erneut, kurz und vollständig, als gültiges JSON gemäß Schema aus." });
      continue;
    }
    return { n: m.n, subject: m.subject, body: m.body, result, tools, kbHits, usage };
  }
  throw new Error("zu viele Runden");
}
(async () => {
  const results: unknown[] = []; let i = 0; const limit = Number(process.env.LIMIT ?? mails.length);
  const queue = mails.slice(0, limit);
  async function worker() { while (i < queue.length) { const m = queue[i++]; try { results.push(await run(m)); } catch (e) { results.push({ n: m.n, error: String(e) }); } if (results.length % 25 === 0) console.log(results.length); } }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  writeFileSync(out, JSON.stringify(results, null, 1));
  const u = (results as { usage?: { i: number; o: number; cr: number; cw: number } }[]).reduce((s, r) => r.usage ? { i: s.i + r.usage.i, o: s.o + r.usage.o, cr: s.cr + r.usage.cr, cw: s.cw + r.usage.cw } : s, { i: 0, o: 0, cr: 0, cw: 0 });
  console.log("fertig", results.length, "Kosten $", (u.i * 2 + u.o * 10 + u.cr * 0.1 + u.cw * 2.5) / 1e6);
  await sql.end();
})();
