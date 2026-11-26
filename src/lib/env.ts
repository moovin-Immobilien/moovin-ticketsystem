import "server-only";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}

export const env = {
  databaseUrl: () => req("DATABASE_URL"),
  appUrl: () =>
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
  // Claude
  anthropicKey: () => process.env.ANTHROPIC_API_KEY ?? "",
  modelDraft: () => process.env.CLAUDE_MODEL_DRAFT ?? "claude-sonnet-5-5",
  // moovin-API (HMAC)
  moovinApiUrl: () => process.env.MOOVIN_API_URL || `${env.appUrl()}/api/mock-moovin/v1`,
  moovinKeyId: () => req("MOOVIN_API_KEY_ID", "proto-1"),
  moovinSecret: () => req("MOOVIN_API_SECRET"),
  // Attrappe: akzeptierte Schlüssel "id:secret,id2:secret2"
  mockMoovinKeys: () => process.env.MOCK_MOOVIN_KEYS ?? `proto-1:${process.env.MOOVIN_API_SECRET ?? ""}`,
  // Inbound-Webhook
  inboundToken: () => req("INBOUND_WEBHOOK_TOKEN"),
  inboundAddress: () => process.env.INBOUND_ADDRESS ?? "mieter@moovin.de",
  // Löschungs-/Auskunftsanfragen nach DSGVO werden hierhin weitergeleitet
  datenschutzAddress: () => process.env.DATENSCHUTZ_ADDRESS ?? "datenschutz@moovin.de",
  // Option: Kopie von Mail und Antwort im Bewerber in moovin ablegen (POST /applicants/{id}/correspondence); "0" schaltet ab
  copyCorrespondence: () => (process.env.MOOVIN_COPY_CORRESPONDENCE ?? "1") === "1",
  // Mail-Dienst für Eingang (Webhook-Format) und Versand: "brevo" (Standard) oder "postmark"
  mailProvider: (): "brevo" | "postmark" => (process.env.MAIL_PROVIDER === "postmark" ? "postmark" : "brevo"),
  brevoApiKey: () => process.env.BREVO_API_KEY ?? "",
  // Nur Tests (nicht in Produktion): Brevo-API auf einen lokalen Testserver umbiegen
  brevoApiBase: () => (process.env.NODE_ENV !== "production" && process.env.BREVO_API_TEST_BASE) || "https://api.brevo.com",
  postmarkToken: () => process.env.POSTMARK_SERVER_TOKEN ?? "",
  fromAddress: () => process.env.MAIL_FROM ?? "moovin Vermietung <mieter@moovin.de>",
  // Login: Google Workspace (nur openid, email, profile)
  googleClientId: () => process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: () => process.env.GOOGLE_CLIENT_SECRET ?? "",
  // Nur Tests (nicht in Produktion): Google-Endpunkte auf einen lokalen Testserver umbiegen
  googleOauthBase: () => (process.env.NODE_ENV !== "production" && process.env.GOOGLE_OAUTH_TEST_BASE) || "",
  allowedDomain: () => process.env.LOGIN_DOMAIN ?? "moovin.de",
  // Übergang: Prototyp-Passwort gilt nur, solange Google nicht eingerichtet ist
  prototypePassword: () => process.env.PROTOTYPE_PASSWORD ?? "",
  // Vercel Cron (Authorization: Bearer <CRON_SECRET>)
  cronSecret: () => process.env.CRON_SECRET ?? "",
  // Löschkonzept: abgeschlossene Tickets (inkl. Nachrichten und Anhängen) nach N Monaten ohne Aktivität löschen.
  // Standard 6, erlaubt 1–36; "0" schaltet das Löschen ab (nur nach Absprache mit dem Datenschutz).
  retentionMonths: (): number => {
    const raw = process.env.RETENTION_MONTHS;
    if (raw === undefined || raw.trim() === "") return 6;
    const n = Number(raw);
    if (n === 0) return 0;
    return Number.isInteger(n) && n >= 1 && n <= 36 ? n : 6;
  },
  // moovin-Anbindung: Standard „an“; „aus“ = Livetest ohne moovin-API (Schalter unter Objekte überschreibt das)
  moovinApiModeDefault: (): "an" | "aus" => (process.env.MOOVIN_API_MODE === "aus" ? "aus" : "an"),
  // Zoho CRM (nur lesend: Objekt → AM). Self Client mit Scopes ZohoCRM.coql.READ, ZohoCRM.modules.deals.READ, ZohoCRM.users.READ
  zohoClientId: () => process.env.ZOHO_CLIENT_ID ?? "",
  zohoClientSecret: () => process.env.ZOHO_CLIENT_SECRET ?? "",
  zohoRefreshToken: () => process.env.ZOHO_REFRESH_TOKEN ?? "",
  zohoAccountsUrl: () => (process.env.NODE_ENV !== "production" && process.env.ZOHO_TEST_BASE) || process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.eu",
  zohoApiBase: () => (process.env.NODE_ENV !== "production" && process.env.ZOHO_TEST_BASE) || process.env.ZOHO_API_BASE || "https://www.zohoapis.eu",
};

export const zohoConfigured = () => !!env.zohoClientId() && !!env.zohoClientSecret() && !!env.zohoRefreshToken();

export const googleLoginEnabled = () => !!env.googleClientId() && !!env.googleClientSecret();
export const passwordLoginEnabled = () => !googleLoginEnabled() && !!env.prototypePassword();

export const demoMode = () => !env.anthropicKey();
