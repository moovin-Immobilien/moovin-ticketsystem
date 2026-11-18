# Architektur

## Überblick

```
 Bewerber ──Mail──▶ Inbound-Dienst (Postmark, MX) ──Webhook──▶ /api/inbound/email
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
| `sessions` | Prototyp-Login (wird durch SSO ersetzt) |

## Autonomie-Entscheidung
Auto-Versand nur wenn: Intent-Modus `auto` ∧ nicht gesperrt ∧ Konfidenz ≥ Schwelle ∧ `needs_human = false` ∧
Absender in moovin bekannt ∧ Antwort nicht leer ∧ (keine Aktionen ∨ Absender verifiziert) ∧ keine KI-/moovin-Fehler.
Messgröße für die Freischaltung: Anteil Entwürfe, die ein AM mit ≥ 97 % Wortähnlichkeit versendet hat (Ziel ≥ 90 %, min. 20 Fälle).

## Sicherheit – Verteidigung in Schichten
1. Webhook-Token (konstante Zeit), Größenlimit.
2. Absenderprüfung DKIM/DMARC (nur oberster bzw. vertrauenswürdiger `Authentication-Results`-Header).
3. moovin-API: HMAC + Zeitstempel (Replay-Schutz 5 min) + IP-Allowlist + `X-Subject-Email`-Bindung + Idempotenz.
4. Claude-Werkzeuge ohne freie Parameter für Personen; Objekt-Abfrage nur für Objekte des Absenders.
5. Aktionen werden serverseitig gegen den moovin-Kontext validiert (nur IDs des Absenders).
6. Antwortadresse aus moovin, nie aus der Mail. `[AM: …]`-Platzhalter blockieren den Versand.
7. Rollen im UI (AM sieht eigene/Pool/Überfällige), Audit-Log, Security-Header.

## Betrieb
- Umgebungsvariablen: siehe `.env.example`.
- Migrationen: `npm run db:migrate` (Tabelle `public.schema_migrations`).
- Inbound-Dienst: Postmark Inbound-Stream → Webhook-URL `https://<app>/api/inbound/email?token=…`; MX/Weiterleitung für mieter@ umstellen.
- Ausgang: Postmark Server-Token; SPF/DKIM für moovin.de beim Versanddienst einrichten.
- Löschkonzept (TODO Pilot): täglicher Job löscht geschlossene Tickets > 6 Monate inkl. Anhänge.

## Übergabe an IT (Guido)
1. `docs/moovin-api.openapi.yaml` in app.moovin.de implementieren (Verhalten wie Attrappe `src/app/api/mock-moovin`).
2. Secret austauschen, `MOOVIN_API_URL` auf echte API setzen, IP-Allowlist einrichten.
3. Attrappe + Schema `mock_moovin` entfernen.
4. Deep-Link in moovin am Bewerber: `https://<app>/tickets?view=offen&email=<adresse>`.
