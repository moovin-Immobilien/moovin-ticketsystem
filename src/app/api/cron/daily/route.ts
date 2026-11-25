import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual, createHash } from "node:crypto";
import { env } from "@/lib/env";
import { syncCrmObjects, zohoReady } from "@/lib/crm/zoho";
import { housekeeping } from "@/lib/workflow";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Vercel Cron (täglich): Hinweise „wartet seit 7 Tagen“, Abwesenheiten → Vertretung, Aufräumen, CRM-Abgleich Objekt → AM (nur lesend). */
export async function GET(req: NextRequest) {
  const secret = env.cronSecret();
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const ok = !!secret && timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(secret).digest());
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await housekeeping("cron");
  await audit("cron", "ticket", { event: "tagespflege", ...r });
  const crm = (await zohoReady()).ready ? await syncCrmObjects("cron") : null;
  return NextResponse.json({ ok: true, ...r, crm: crm ? { ok: crm.ok, rows: crm.rows, withAm: crm.withAm, error: crm.error } : "nicht eingerichtet" });
}
