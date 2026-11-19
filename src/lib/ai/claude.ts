import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";
import { sql } from "../db";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA } from "./prompt";
import type { AgentInput, AgentOutput, AgentResult } from "./types";

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_application_status",
    description: "Liefert die Bewerbungen des Absenders dieser Mail: Objekt, Status (bewerbertaugliche Formulierung), fehlende Unterlagen, nächster Schritt, Besichtigungstermin. Keine Parameter – an den Absender gebunden.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_object_info",
    description: "Öffentliche Inseratsdaten (Adresse, Größe, Miete, Bezugstermin, Haustiere, Parken, WBS, Ablauf Besichtigung). Nur für Inserate, auf die sich der Absender beworben hat; listing_id aus get_application_status.",
    input_schema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"], additionalProperties: false },
  },
  {
    name: "search_knowledge",
    description: "Durchsucht die moovin-Wissensdatenbank (allgemeine FAQ + Ergänzungen der AMs zu den Objekten des Absenders). Stichworte auf Deutsch.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
];

function berlinNow() {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", dateStyle: "full", timeStyle: "short" }).format(new Date());
}

function buildUserMessage(i: AgentInput): string {
  const hist = i.history.slice(-6).map((h) => `[${h.direction === "in" ? "Bewerber" : "moovin"} · ${h.at}]\n${h.text.slice(0, 2000)}`).join("\n\n");
  return [
    `Heute: ${berlinNow()} (Europe/Berlin)`,
    `Absender: ${i.senderName || "(ohne Namen)"} <${i.senderEmail}>`,
    `Absender in moovin bekannt: ${i.context ? "ja" : "nein"}`,
    `Absender verifiziert (DKIM/DMARC): ${i.senderVerified ? "ja" : "nein"}`,
    `Anhänge: ${i.attachments.length ? i.attachments.map((a) => `${a.filename} (${a.contentType})`).join(", ") : "keine"}`,
    hist ? `\nBisheriger Verlauf:\n<verlauf>\n${hist}\n</verlauf>` : "",
    `\nNeue Mail – Betreff: ${i.subject || "(leer)"}\n<email>\n${i.newMessage.slice(0, 8000)}\n</email>`,
    `\nErstelle Analyse und Antwortentwurf gemäß Vorgaben.`,
  ].join("\n");
}

// Harte Budgetgrenze pro Kalendermonat (USD). Bei Überschreitung → Fallback auf Regeln, Ticket geht an Menschen.
// Preise Claude Sonnet 5.5: Input 2 $, Output 10 $, Cache-Read 0,10 $ je Mio. Tokens.
const PRICE = { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 2.5 / 1e6 };

export async function monthSpendUsd(): Promise<number> {
  const [r] = await sql`
    select coalesce(sum((usage->>'input_tokens')::numeric), 0) as i,
           coalesce(sum((usage->>'output_tokens')::numeric), 0) as o,
           coalesce(sum((usage->>'cache_read_input_tokens')::numeric), 0) as cr,
           coalesce(sum((usage->>'cache_creation_input_tokens')::numeric), 0) as cw
    from ticket.drafts
    where usage is not null and created_at >= date_trunc('month', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'`;
  return Number(r.i) * PRICE.input + Number(r.o) * PRICE.output + Number(r.cr) * PRICE.cacheRead + Number(r.cw) * PRICE.cacheWrite;
}

export async function runClaudeAgent(i: AgentInput): Promise<AgentOutput> {
  const budget = Number(process.env.CLAUDE_MONTHLY_BUDGET_USD ?? 50);
  const spent = await monthSpendUsd();
  if (spent >= budget) throw new Error(`Monatsbudget Claude erreicht (${spent.toFixed(2)} von ${budget} $)`);
  const client = new Anthropic({ apiKey: env.anthropicKey() });
  const model = env.modelDraft();
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildUserMessage(i) }];
  const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const toolCalls: string[] = [];

  for (let turn = 0; turn < 6; turn++) {
    const res = await client.messages.create({
      model,
      max_tokens: 12000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA as unknown as Record<string, unknown> } },
    });
    usage.input_tokens += res.usage.input_tokens ?? 0;
    usage.output_tokens += res.usage.output_tokens ?? 0;
    usage.cache_read_input_tokens += res.usage.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += res.usage.cache_creation_input_tokens ?? 0;

    if (res.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        toolCalls.push(block.name);
        let out: unknown;
        try {
          const input = block.input as Record<string, string>;
          if (block.name === "get_application_status") out = (await i.tools.getApplicationStatus()) ?? { info: "Absender in moovin unbekannt" };
          else if (block.name === "get_object_info") out = (await i.tools.getObjectInfo(String(input.listing_id ?? input.object_id ?? ""))) ?? { info: "Inserat nicht gefunden oder nicht freigegeben" };
          else if (block.name === "search_knowledge") out = await i.tools.searchKnowledge(String(input.query ?? ""));
          else out = { error: "Unbekanntes Werkzeug" };
        } catch (e) {
          out = { error: `Werkzeugfehler: ${(e as Error).message}` };
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    try {
      const parsed = JSON.parse(text) as AgentResult;
      return { result: parsed, model, usage, toolCalls };
    } catch {
      // Abgeschnittene oder ungültige Ausgabe (z. B. stop_reason max_tokens): einmal neu anfordern
      if (res.stop_reason === "max_tokens" || turn < 5) {
        messages.push({ role: "assistant", content: res.content });
        messages.push({ role: "user", content: "Deine letzte Ausgabe war kein vollständiges JSON. Gib die Analyse jetzt erneut, kurz und vollständig, als gültiges JSON gemäß Schema aus." });
        continue;
      }
      throw new Error(`Claude: ungültige Ausgabe (${res.stop_reason})`);
    }
  }
  throw new Error("Claude: zu viele Werkzeug-Runden");
}
