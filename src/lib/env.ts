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
  // Ausgang
  postmarkToken: () => process.env.POSTMARK_SERVER_TOKEN ?? "",
  fromAddress: () => process.env.MAIL_FROM ?? "moovin Vermietung <mieter@moovin.de>",
  // Prototyp-Login
  prototypePassword: () => req("PROTOTYPE_PASSWORD"),
  allowedDomain: () => process.env.LOGIN_DOMAIN ?? "moovin.de",
};

export const demoMode = () => !env.anthropicKey();
