// Prüfung des ID-Tokens von Google (OpenID Connect). Das Token kommt direkt per TLS vom Token-Endpunkt
// (mit Client-Secret), daher genügt laut OIDC Core 3.1.3.7 die Prüfung der Claims; die Signatur muss nicht
// zusätzlich verifiziert werden. Reine Funktion → in Tests ohne Netz prüfbar.

export type IdClaims = {
  iss?: string; aud?: string | string[]; exp?: number; iat?: number; nonce?: string;
  sub?: string; email?: string; email_verified?: boolean | string; hd?: string; name?: string;
};

export function decodeJwtPayload(jwt: string): IdClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("ID-Token ungültig");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdClaims;
}

export function checkIdClaims(c: IdClaims, opts: { clientId: string; nonce: string; domain: string; now?: number }):
  { ok: true; email: string; sub: string; name: string } | { ok: false; error: string } {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") return { ok: false, error: "Aussteller ungültig" };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) return { ok: false, error: "Token nicht für diese Anwendung" };
  if (!c.exp || c.exp < now - 60) return { ok: false, error: "Token abgelaufen" };
  if (!c.nonce || c.nonce !== opts.nonce) return { ok: false, error: "Nonce passt nicht" };
  if (!c.sub) return { ok: false, error: "Konto-ID fehlt" };
  const email = String(c.email ?? "").trim().toLowerCase();
  if (!email || !(c.email_verified === true || c.email_verified === "true")) return { ok: false, error: "E-Mail nicht bestätigt" };
  const domain = opts.domain.toLowerCase();
  // hd ist nur bei Google-Workspace-Konten gesetzt → private Gmail-Konten sind ausgeschlossen
  if (c.hd?.toLowerCase() !== domain || !email.endsWith("@" + domain)) return { ok: false, error: `Nur Konten der Domain ${domain}` };
  return { ok: true, email, sub: c.sub, name: String(c.name ?? "").trim() || email.split("@")[0] };
}
