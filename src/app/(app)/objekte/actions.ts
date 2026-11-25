"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { setMoovinMode } from "@/lib/settings";
import { syncCrmObjects } from "@/lib/crm/zoho";

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
