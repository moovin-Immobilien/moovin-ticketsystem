// Objekt-Erkennung im Mailtext und Namensabgleich AM → Mailadresse. Reine Funktionen (ohne DB), damit sie testbar bleiben.

export type CrmObject = {
  object_id: string; // moovin-ID (z. B. MV-ABC123) oder CRM-<id>
  title: string | null;
  street: string | null;
  zip: string | null;
  match_key: string | null; // normalisierte „Straße Hausnummer“
  am_email: string | null;
  am_name: string | null;
  /** in Vermarktung (online, Quervermarktung, Mieter vorschlagen, Mietvertrag, Exposé) – gewinnt bei Mehrdeutigkeit */
  live?: boolean;
};

export type ObjectMatch = {
  how: "moovin_id" | "adresse" | null;
  candidates: CrmObject[];
  /** genau ein AM über alle Treffer → zuständig; sonst null */
  amEmail: string | null;
  amName: string | null;
  /** Objekt nur, wenn alle Treffer dieselbe Adresse haben */
  object: CrmObject | null;
  note: string | null;
};

/** Kleinbuchstaben, Umlaute ausgeschrieben, „Straße/Strasse/Str.“ → „str“, Bindestriche/Satzzeichen → Leerzeichen, „25 a“ → „25a“. */
export function normalizeAddress(s: string): string {
  return ` ${s} `
    .toLowerCase()
    .replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[-_,;:()"'„“”/\\|]+/g, " ")
    .replace(/(strasse|str\.|str)(?=[\s\d.]|$)/g, "str ")
    .replace(/\s+str(?=\s)/g, "str")
    .replace(/\.(?!\d)/g, " ")
    .replace(/(\d+)\s+([a-z])(?![a-z0-9])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Schlüssel für die Adress-Suche: nur mit Hausnummer, sonst null (z. B. Stellplätze ohne Nummer). */
export function addressKey(street: string | null | undefined): string | null {
  if (!street) return null;
  const n = normalizeAddress(street);
  // „Overbeckstraße 2-4“ → „overbeckstr 2“ (erste Hausnummer genügt)
  const m = n.match(/^(.*?\D)\s?(\d+[a-z]?)(?:\s.*)?$/);
  if (!m) return null;
  const key = `${m[1].trim()} ${m[2]}`.replace(/\s+/g, " ");
  return key.length >= 6 ? key : null;
}

const ID_RE = /\bMV-[A-Z]{3}\d{3}\b/gi;

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Sucht Objekte im Mailtext: zuerst moovin-ID (MV-ABC123), dann „Straße Hausnummer“ (mit PLZ zur Unterscheidung,
 * wenn dieselbe Adresse in mehreren Orten vorkommt). Zuständig ist der AM nur, wenn alle Treffer denselben AM haben.
 */
export function matchObjects(text: string, objects: CrmObject[]): ObjectMatch {
  const none: ObjectMatch = { how: null, candidates: [], amEmail: null, amName: null, object: null, note: null };
  if (!text.trim() || !objects.length) return none;

  let how: ObjectMatch["how"] = null;
  let cands: CrmObject[] = [];
  const ids = new Set((text.match(ID_RE) ?? []).map((x) => x.toUpperCase()));
  if (ids.size) {
    cands = objects.filter((o) => ids.has(o.object_id.toUpperCase()));
    if (cands.length) how = "moovin_id";
  }
  if (!cands.length) {
    const norm = ` ${normalizeAddress(text)} `;
    cands = objects.filter((o) => o.match_key && new RegExp(`[^a-z0-9]${escapeRe(o.match_key)}(?![0-9a-z])`).test(norm));
    if (cands.length) {
      how = "adresse";
      // Gleiche Straße in mehreren Orten: PLZ aus dem Text entscheidet, wenn vorhanden
      const zips = new Set(cands.map((c) => c.zip).filter(Boolean));
      if (zips.size > 1) {
        const inText = cands.filter((c) => c.zip && new RegExp(`(^|\\D)${c.zip}(\\D|$)`).test(text));
        if (inText.length) cands = inText;
      }
      // „Markt 1“ steckt in „Am Markt 1“: der längere Treffer gewinnt
      cands = cands.filter((c) => !cands.some((d) => d.match_key!.length > c.match_key!.length && d.match_key!.endsWith(c.match_key!)));
    }
  }
  if (!cands.length) return none;

  // Verschiedene AMs an derselben Adresse: Objekte in Vermarktung haben Vorrang vor Auftragseingang/On Hold
  if (new Set(cands.map((c) => c.am_email)).size > 1 && cands.some((c) => c.live)) cands = cands.filter((c) => c.live);
  const ams = [...new Set(cands.map((c) => c.am_email).filter(Boolean))] as string[];
  const addrs = new Set(cands.map((c) => c.match_key ?? c.object_id));
  const object = addrs.size === 1 ? cands[0] : null;
  const amEmail = ams.length === 1 && cands.every((c) => c.am_email === ams[0]) ? ams[0] : null;
  const amName = amEmail ? cands.find((c) => c.am_email === amEmail)?.am_name ?? null : null;
  let note: string | null = null;
  if (!amEmail && ams.length > 1) note = `Mehrere Objekte verschiedener AMs erkannt (${[...new Set(cands.map((c) => c.am_name).filter(Boolean))].join(", ")})`;
  else if (!amEmail) note = `Objekt erkannt (${cands[0].title ?? cands[0].object_id}), aber kein AM im CRM zuordenbar`;
  return { how, candidates: cands.slice(0, 10), amEmail, amName, object, note };
}

// ---------- AM-Name (CRM-Auswahlliste) → Mailadresse (CRM-Benutzer) ----------

function normName(s: string) {
  return s.toLowerCase().replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Ordnet einen AM-Namen aus dem CRM („Lillyan-Mia Gehlsen“) einem CRM-Benutzer zu („Lilly Gehlsen“, gehlsen@…).
 * Regel: gleicher Nachname und ein Vorname-Teil ist Präfix des anderen (mind. 3 Zeichen). Aktive Benutzer zuerst.
 * Mehrdeutig → null (lieber Allgemeiner Eingang als falscher AM).
 */
export function resolveAmEmail(name: string, users: { full_name: string; email: string; active: boolean }[]): string | null {
  const n = normName(name);
  if (!n) return null;
  const exact = users.filter((u) => normName(u.full_name) === n);
  const pick = (list: typeof users) => {
    const act = list.filter((u) => u.active);
    const pool = act.length ? act : list;
    const emails = [...new Set(pool.map((u) => u.email.toLowerCase()))];
    return emails.length === 1 ? emails[0] : null;
  };
  if (exact.length) return pick(exact);
  const parts = n.split(" ");
  const last = parts.at(-1)!;
  const firsts = parts.slice(0, -1).flatMap((p) => p.split("-")).filter((p) => p.length >= 3);
  const fuzzy = users.filter((u) => {
    const q = normName(u.full_name).split(" ");
    if (q.at(-1) !== last) return false;
    const qf = q.slice(0, -1).flatMap((p) => p.split("-")).filter((p) => p.length >= 3);
    return firsts.some((a) => qf.some((b) => a.startsWith(b) || b.startsWith(a)));
  });
  return fuzzy.length ? pick(fuzzy) : null;
}
