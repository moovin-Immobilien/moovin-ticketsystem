"use server";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { audit } from "@/lib/audit";

export async function saveArticle(form: FormData) {
  const agent = await requireAgent();
  const id = Number(form.get("id") ?? 0);
  const scope = form.get("scope") === "objekt" ? "objekt" : "global";
  if (scope === "global" && agent.role !== "admin") throw new Error("Allgemeine FAQ pflegt Ops/Admin");
  const objectId = scope === "objekt" ? String(form.get("object_id") ?? "").trim() : null;
  if (scope === "objekt" && !objectId) throw new Error("Objekt-ID fehlt");
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  const tags = String(form.get("tags") ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const status = form.get("status") === "entwurf" ? "entwurf" : "aktiv";
  if (!title || !body) throw new Error("Titel und Text sind Pflicht");
  if (id) {
    await sql`update ticket.knowledge_articles set scope = ${scope}, object_id = ${objectId}, title = ${title}, body = ${body}, tags = ${tags},
              status = ${status}, updated_by = ${agent.email}, updated_at = now() where id = ${id}`;
  } else {
    await sql`insert into ticket.knowledge_articles (scope, object_id, title, body, tags, status, updated_by)
              values (${scope}, ${objectId}, ${title}, ${body}, ${tags}, ${status}, ${agent.email})`;
  }
  await audit(`am:${agent.email}`, "knowledge", { id: id || "neu", title });
  revalidatePath("/wissen");
}

export async function deleteArticle(id: number) {
  const agent = await requireAgent();
  const [a] = await sql`select scope from ticket.knowledge_articles where id = ${id}`;
  if (!a) return;
  if (a.scope === "global" && agent.role !== "admin") throw new Error("Keine Berechtigung");
  await sql`delete from ticket.knowledge_articles where id = ${id}`;
  await audit(`am:${agent.email}`, "knowledge", { id, event: "gelöscht" });
  revalidatePath("/wissen");
}
