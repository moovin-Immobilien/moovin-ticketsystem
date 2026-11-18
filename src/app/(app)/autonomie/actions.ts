"use server";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function updateIntent(form: FormData) {
  const agent = await requireAdmin();
  const intent = String(form.get("intent"));
  const mode = form.get("mode") === "auto" ? "auto" : "entwurf";
  const threshold = Math.min(0.99, Math.max(0.5, Number(form.get("threshold") ?? 0.85)));
  const [s] = await sql`select locked from ticket.intent_settings where intent = ${intent}`;
  if (!s) return;
  if (s.locked && mode === "auto") throw new Error("Dieses Anliegen bleibt immer menschlich");
  await sql`update ticket.intent_settings set mode = ${mode}, threshold = ${threshold}, updated_by = ${agent.email}, updated_at = now() where intent = ${intent}`;
  await audit(`am:${agent.email}`, "settings", { intent, mode, threshold });
  revalidatePath("/autonomie");
}
