import "server-only";
import { sql } from "./db";
import { env } from "./env";
import { audit } from "./audit";

export async function getSetting<T>(key: string): Promise<T | null> {
  const [r] = await sql`select value from ticket.settings where key = ${key}`;
  return r ? (r.value as T) : null;
}

export async function setSetting(key: string, value: unknown, actor: string) {
  await sql`insert into ticket.settings (key, value, updated_at, updated_by) values (${key}, ${sql.json(value as never)}, now(), ${actor})
            on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
}

/**
 * moovin-Anbindung an/aus. „aus“ = Livetest ohne moovin-API: keine Abfragen und Schreibaufrufe an moovin,
 * die KI arbeitet ohne Bewerberdaten (neutrale Formulierung, keine Platzhalter), Aktionen werden zu Aufgaben für den AM.
 * Der Schalter (Admin, Seite „Objekte“) überschreibt die Umgebungsvariable MOOVIN_API_MODE.
 */
export async function moovinEnabled(): Promise<boolean> {
  const v = await getSetting<string>("moovin_api").catch(() => null);
  return (v ?? env.moovinApiModeDefault()) === "an";
}

export async function setMoovinMode(on: boolean, actor: string) {
  await setSetting("moovin_api", on ? "an" : "aus", actor);
  await audit(actor, "settings", { event: "moovin_anbindung", value: on ? "an" : "aus" });
}
