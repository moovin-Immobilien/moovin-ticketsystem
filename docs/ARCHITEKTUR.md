# Architektur

## Überblick

```
 Bewerber ──Mail──▶ Inbound-Dienst (Brevo, MX) ───Webhook──▶ /api/inbound/email
                                                                   │  Token-geprüft, antwortet sofort,
                                                                   ▼  verarbeitet danach (after())
                                                   ┌──────── Ticketsystem (Vercel, fra1) ────────┐
                                                   │ 1 Dublettenprüfung (Message-ID)             │
                                                   │ 2 DKIM/DMARC → sender_verified              │
                                                   │ 3 Threading (Message-ID / [#T-x] / Absender)│
                                                   │ 4 Nachricht + Anhänge speichern             │
                                                   │ 5 moovin-API: Bewerber-Kontext, AM          │──HMAC──▶ moovin Ticket-API
                                                   │ 6 Claude: Werkzeuge an Absender gebunden    │◀────────  (Guido)
                                                   │ 7 Aktionen serverseitig validieren          │
                                                   │ 8 Auto-Regel? → senden + Aktionen           │──HMAC──▶ moovin (Schreiben)
                                                   │   sonst → Entwurf für AM                    │
                                                   └──────────────┬──────────────────────────────┘
                                                                  ▼
                                               Postgres (Supabase Frankfurt, Schemas ticket/mock_moovin)
```

## Datenmodell (Schema `ticket`)

| Tabelle | Zweck |
|---|---|
| `agents` | AMs/Admins (Rolle `am`/`admin`) |
| `tickets` | Ein Vorgang pro Absender-Thread. Referenz auf Bewerber in moovin (`applicant_id`), **keine Kopie** der Bewerberdaten. `reply_to_email` = hinterlegte Adresse. Intent, Konfidenz, Fälligkeit, Zuständigkeit |
| `messages` | Ein-/ausgehende Mails inkl. Message-ID, Auth-Results, Versandstatus |
| `attachments` | Anhänge (bytea), `forwarded_at` sobald an moovin übergeben |
| `drafts` | KI-Entwürfe inkl. Analyse (JSON), Modell, Tokens, gesendeter Text, Ähnlichkeit → „unverändert“-Quote |
| `actions` | Vorgeschlagene/ausgeführte moovin-Aktionen, idempotent (`idempotency_key`), Status inkl. `blockiert` |
| `knowledge_articles` | FAQ global + Ergänzungen je Objekt, deutsche Volltextsuche (tsvector) |
| `intent_settings` | Autonomie je Anliegen (Modus, Schwelle, gesperrt) |
| `audit_log` | Insert-only (Trigger verhindert Update/Delete) |
| `sessions` | Login-Sitzungen (12 h) |
| `oauth_states` | Kurzlebiger Zustand des Google-Logins (state, nonce, PKCE) |
| `tasks` | Aufgaben für AMs (Verschiebewunsch, Rückzug, Interesse, Notiz, nachfassen), offen/erledigt |
| `notes` | Interne Notizen und Weitergaben – nie an Bewerber, moovin oder KI |
| `presence` | Wer hat ein Ticket gerade offen (Bearbeitungssperre, nur Anzeige) |

## Autonomie-Entscheidung
Auto-Versand nur wenn: Intent-Modus `auto` ∧ nicht gesperrt ∧ Konfidenz ≥ Schwelle ∧ `needs_human = false` ∧
Absender in moovin bekannt ∧ Antwort nicht leer ∧ (keine Aktionen ∨ Absender verifiziert) ∧ keine KI-/moovin-Fehler.
Messgröße für die Freischaltung: Anteil Entwürfe, die ein AM mit ≥ 97 % Wortähnlichkeit versendet hat (Ziel ≥ 90 %, min. 20 Fälle).

## Sicherheit – Verteidigung in Schichten
1. Webhook-Token (konstante Zeit), Größenlimit.
2. Absenderprüfung DKIM/DMARC (nur oberster bzw. vertrauenswürdiger `Authentication-Results`-Header).
3. moovin-API: HMAC + Zeitstempel (Replay-Schutz 5 min) + `X-Subject-Email`-Bindung + Idempotenz (keine IP-Allowlist).
4. Claude-Werkzeuge ohne freie Parameter für Personen; Objekt-Abfrage nur für Objekte des Absenders.
5. Aktionen werden serverseitig gegen den moovin-Kontext validiert (nur IDs des Absenders).
6. Antwortadresse aus moovin, nie aus der Mail. `[AM: …]`-Platzhalter blockieren den Versand.
7. Login nur über Google Workspace (hd=moovin.de, PKCE, Nonce, nur openid/email/profile); neue Adressen erst nach Freischaltung.
8. Rollen im UI (AM sieht eigene/Allgemeiner Eingang/Überfällige), Audit-Log, Security-Header.

## Betrieb
- Umgebungsvariablen: siehe `.env.example`.
- Migrationen: `npm run db:migrate` (Tabelle `public.schema_migrations`).
- Mail-Dienst: `MAIL_PROVIDER=brevo` (Standard) oder `postmark`.
  - Brevo Eingang: Empfangs-Subdomain (MX inbound1/2.sendinblue.com), Webhook `type=inbound`, URL `https://<app>/api/inbound/email?token=…`,
    mieter@moovin.de leitet an die Subdomain weiter. Anhänge lädt das System per `BREVO_API_KEY` nach.
  - Brevo Versand: `BREVO_API_KEY`, Absenderdomain moovin.de verifizieren (SPF/DKIM). Reply-To = `INBOUND_ADDRESS`.
- Google-Login: OAuth-Client (Typ Webanwendung) im Google-Cloud-Projekt der Workspace-Organisation, Weiterleitungs-URI
  `https://<app>/api/auth/google/callback`, Zielgruppe „intern“. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` setzen.
- Täglicher Cron (vercel.json, `/api/cron/daily`, `CRON_SECRET`): Hinweise „wartet seit 7 Tagen“, Abwesenheiten, Aufräumen.
- Tests: `npm run test:e2e` (lokal, Demo-Modus, Testserver für Google und Brevo), `npm run api:check` (Konformität moovin-API).
- Löschkonzept (TODO Pilot): täglicher Job löscht geschlossene Tickets > 6 Monate inkl. Anhänge.

## Übergabe an IT (Guido)
1. `docs/moovin-api.openapi.yaml` in app.moovin.de implementieren (Verhalten wie Attrappe `src/app/api/mock-moovin`).
2. Secret austauschen, `MOOVIN_API_URL` auf echte API setzen.
3. Attrappe + Schema `mock_moovin` entfernen.
4. Deep-Link in moovin am Bewerber: `https://<app>/tickets?view=offen&email=<adresse>`.
