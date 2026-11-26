"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { requireAgent, requireAdmin, TEST_COOKIE } from "@/lib/auth";
import { processInbound } from "@/lib/pipeline";
import type { InboundMail } from "@/lib/inbound/parse";
import { newRunId, planRun, loadCase, deleteTestTickets, RUN_RE, type PlanItem, type CaseResult } from "@/lib/testbatterie";

// Kleines Test-PDF als Anhang (Inhalt egal – wird nie an Claude gegeben)
const DUMMY_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");

export async function simulateAction(form: FormData) {
  const agent = await requireAgent();
  const from = String(form.get("from") ?? "").trim().toLowerCase();
  const verified = form.get("verified") === "on";
  const attach = form.get("attach") === "on";
  const isTest = form.get("is_test") === "on";
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
  const { ticketId } = await processInbound(mail, isTest ? `test:${agent.email}` : `am:${agent.email}`, [], { isTest });
  redirect(`/tickets/${ticketId}`);
}

// ---------- Testbatterie (nur Admin) ----------

/** Neuer Lauf: Laufkennung und Plan (Objekt je Fall). Eingespielt wird danach je Fall einzeln (Client-Schleife). */
export async function prepareTestbatterieAction(keys: string[]): Promise<{ run: string; plan: PlanItem[] }> {
  await requireAdmin();
  const run = newRunId();
  return { run, plan: await planRun(run, Array.isArray(keys) ? keys.map(String) : []) };
}

/** Einen Fall einspielen (eigener Request, damit kein Vercel-Timeout greift). */
export async function loadTestCaseAction(run: string, key: string, objectId: string | null): Promise<CaseResult> {
  const admin = await requireAdmin();
  return loadCase(String(run), String(key), objectId ? String(objectId) : null, `test:${admin.email}`);
}

export async function deleteTestTicketsAction(form: FormData) {
  const admin = await requireAdmin();
  if (form.get("confirm") !== "on") redirect("/simulieren?geloescht=bestaetigen");
  const raw = String(form.get("run") ?? "");
  const run = RUN_RE.test(raw) ? raw : null;
  const n = await deleteTestTickets(`am:${admin.email}`, run);
  revalidatePath("/", "layout");
  redirect(`/simulieren?geloescht=${n}`);
}

/** Schalter „Testtickets ein-/ausblenden“ (je Browser). */
export async function toggleTestTicketsAction(show: boolean) {
  await requireAgent();
  (await cookies()).set(TEST_COOKIE, show ? "1" : "0", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 365 * 24 * 3600, secure: process.env.NODE_ENV === "production" });
  revalidatePath("/", "layout");
}
