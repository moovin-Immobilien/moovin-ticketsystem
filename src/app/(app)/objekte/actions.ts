"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { setMoovinMode } from "@/lib/settings";
import { syncCrmObjects, connectZoho, disconnectZoho } from "@/lib/crm/zoho";

/** moovin-Anbindung an/aus (Livetest ohne moovin-API). */
export async function setMoovinModeAction(on: boolean) {
  const admin = await requireAdmin();
  await setMoovinMode(on, `am:${admin.email}`);
  revalidatePath("/", "layout");
}

/** CRM-Abgleich sofort (sonst täglich per Cron). Nur lesend. */
export async function syncCrmAction() {
  const admin = await requireAdmin();
  await syncCrmObjects(`am:${admin.email}`);
  revalidatePath("/objekte");
}

/** Zoho einmalig verbinden (Self Client: Client ID, Client Secret, Code mit Lese-Scopes) und gleich abgleichen. */
export async function connectZohoAction(form: FormData) {
  const admin = await requireAdmin();
  let msg = "";
  try {
    await connectZoho({ clientId: String(form.get("client_id") ?? ""), clientSecret: String(form.get("client_secret") ?? ""), code: String(form.get("code") ?? "") }, `am:${admin.email}`);
    const r = await syncCrmObjects(`am:${admin.email}`);
    msg = r.ok ? `Verbunden – ${r.rows} Objekte abgeglichen.` : `Verbunden, Abgleich fehlgeschlagen: ${r.error}`;
  } catch (e) {
    msg = (e as Error).message;
  }
  revalidatePath("/objekte");
  redirect(`/objekte?zoho=${encodeURIComponent(msg)}`);
}

export async function disconnectZohoAction() {
  const admin = await requireAdmin();
  await disconnectZoho(`am:${admin.email}`);
  revalidatePath("/objekte");
}
