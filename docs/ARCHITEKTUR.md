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
                                                   │   sonst/aus: Objekt im Text → AM laut CRM   │◀─täglich, nur lesend── Zoho CRM
                                                   │ 6 Claude: Werkzeuge an Absender gebunden    │◀────────  (Guido)
                                                   │ 7 Aktionen validieren, Signale → Stufe 1–4  │
                                                   │ 8 Auto-Regel? → senden + Aktionen           │──HMAC──▶ moovin (Schreiben)
                                                   │   sonst → Entwurf für AM                    │
                                                   └──────────────┬─────────────────────────────┘
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
| `tasks` | Aufgaben für AMs – **höchstens eine offene je Ticket**: erste Zeile = Titel (dringendster Punkt), weitere Zeilen = Checkliste („• …“). Neue Punkte (Aktionen, Signale, Folgemails) werden ergänzt statt neu angelegt (`createTask` in `src/lib/workflow.ts`); Priorität/Fälligkeit = das Dringendste |
| `notes` | Interne Notizen und Weitergaben – nie an Bewerber, moovin oder KI |
| `presence` | Wer hat ein Ticket gerade offen (Bearbeitungssperre, nur Anzeige) |
| `crm_objects` | Spiegel aus Zoho CRM: Objekt (moovin-ID/Adresse) → AM-Name und -Adresse, Phase, „in Vermarktung“; täglicher Abgleich |
| `settings` | Schalter und Stände, z. B. `moovin_api` (an/aus), `crm_sync` (letzter Abgleich), `signals_off` (abgeschaltete Signale) |
| `signal_feedback` | „Markierung passt nicht“ je Ticket und Signal → Trefferquote (Ticket-Intelligenz) |
| `test_results` | Testbatterie: Ergebnis je Lauf und Fall (Soll aus `src/lib/testbatterie.json`, Ist = Stand des Tickets direkt nach dem Fall, Fehler, Dauer); wird mit dem Ticket gelöscht |
| `test_runs` | Testbatterie: Plan je Lauf (Objekt je Fall), damit ein abgebrochener Lauf mit denselben Objekten fortgesetzt werden kann („Fehlende Fälle nachladen“) |

Testtickets: `tickets.is_test` (boolean, Standard `false`, Index) wird in `processInbound` beim **Anlegen** des Tickets gesetzt – also
bevor `analyzeTicket` läuft; Folgemails im selben Thread erben es über das Ticket. Testmails threaden nur in Testtickets desselben Laufs
(`tickets.test_run`, z. B. `20261126-153012`), nie in echte Tickets. Testtickets zählen in keiner Kennzahl (Dashboard, Autonomie-/„unverändert“-Quote,
Signal-Trefferquote, Auto-Quote, Überfällig, Team, Routing-Statistik) und erzeugen keine Tagescron-Hinweise. In Listen per Schalter „TEST ein/aus“
(Cookie, Standard: Admin ein, AM aus), Badge „TEST“. Loader, Bericht und Löschen: `src/lib/testbatterie.ts`, Seiten `/simulieren` und `/simulieren/bericht`.

Ticket-Intelligenz: `tickets.priority` (1 Chance, 2 zeitkritisch, 3 normal, 4 kein Handlungsbedarf), `tickets.signals` (Signal, Beleg,
bestätigt, Basis Daten/Mail), `chance_at`/`chance_answered_at`/`chance_won_at` für die Messung, `tasks.priority`. Logik: `src/lib/signals.ts`
(reine Funktionen, getestet), Aufgaben aus Fall B: `signalTasks` in `src/lib/workflow.ts`. Spam/Systemmails: `AUTO_CLOSE_INTENTS` und
`autoClose` in `src/lib/pipeline.ts` (nur bei der ersten Mail eines Tickets; `tickets.auto_closed`, Migration 013). Datenschutz-Anliegen:
Antwort mit CC an `DATENSCHUTZ_ADDRESS` (`messages.cc_email`), Aktion `datenschutz_weiterleiten` wird dann übersprungen. In der Ticketansicht
werden alle manuellen Aktionen als eine Karte „Eine Aufgabe für den AM“ mit Checkliste gezeigt (DraftPanel). Testbatterie-Loader überspringt
Stellplatz-/Garagen-Objekte.

## Autonomie-Entscheidung
Auto-Versand nur wenn: Intent-Modus `auto` ∧ nicht gesperrt ∧ Konfidenz ≥ Schwelle ∧ `needs_human = false` ∧
Absender in moovin bekannt (bei moovin-Anbindung aus: nur allgemeine Anliegen) ∧ Antwort nicht leer und ohne `[AM: …]`-Hinweis (Sicherheitsnetz; der Prompt erzeugt keine Platzhalter mehr) ∧
keine Aufgaben-Aktionen ∧ (keine Aktionen ∨ Absender verifiziert) ∧ keine KI-/moovin-Fehler ∧ kein Signal aus Fall C/D
(Anmietwunsch, Vertrag, Frist, Eskalation, kein Handlungsbedarf) ∧ kein Testticket.
Messgröße für die Freischaltung: Anteil Entwürfe, die ein AM mit ≥ 97 % Wortähnlichkeit versendet hat (Ziel ≥ 90 %, min. 20 Fälle).

## Sicherheit – Verteidigung in Schichten
1. Webhook-Token (konstante Zeit), Größenlimit.
2. Absenderprüfung DKIM/DMARC (nur oberster bzw. vertrauenswürdiger `Authentication-Results`-Header).
3. moovin-API: HMAC + Zeitstempel (Replay-Schutz 5 min) + `X-Subject-Email`-Bindung + Idempotenz (keine IP-Allowlist).
4. Claude-Werkzeuge ohne freie Parameter für Personen; Objekt-Abfrage nur für Objekte des Absenders.
5. Aktionen werden serverseitig gegen den moovin-Kontext validiert (nur IDs des Absenders).
6. Antwortadresse aus moovin, nie aus der Mail. Ein `[AM: …]`-Hinweis im Text blockiert den Versand (Sicherheitsnetz). Der Prompt erzeugt keine
   Platzhalter: Fehlt eine Information, formuliert die KI so, dass der Satz ohne sie richtig ist, und behauptet nie, etwas sei in moovin
   vermerkt oder erledigt, wenn keine Aktion das wirklich tut. Abläufe, die je Objekt abweichen (Vertragsweg, Kaution, Übergabe), nur allgemein.
7. Login nur über Google Workspace (hd=moovin.de, PKCE, Nonce, nur openid/email/profile); neue Adressen erst nach Freischaltung.
8. Rollen im UI (AM sieht eigene/Allgemeiner Eingang/Überfällige), Audit-Log, Security-Header.
9. **Testsperre** (`deliver()` in `src/lib/mailer.ts`, vor jedem Versanddienst): Ist das Ticket `is_test` (aus der Datenbank gelesen, nicht vom
   Aufrufer übergeben) oder liegt die Empfängerdomain auf einer reservierten Testdomain (`example.com|org|net` inkl. Subdomains, `*.example`,
   `*.test`, `*.invalid`, `*.local`), wird **nie** Brevo/Postmark aufgerufen: Rückgabe „simuliert“, Audit `mail_out` mit `mode: "test_gesperrt"`
   und Grund. Gilt für alle Wege – Antworten (`sendMailDetailed`), interne Mails (`sendMail`: Verschiebewunsch an AM, Datenschutz-Weiterleitung)
   und Auto-Versand. Zusätzlich für Testtickets: Auto-Versand immer aus, keine Schreibaufrufe an moovin (Aktionen werden wie bei
   „moovin-Anbindung aus“ zu Aufgaben; zweite Sicherung in `executeAction`), keine Kopie der Korrespondenz in moovin. Lesende moovin-Abfragen bleiben.

## Betrieb
- Umgebungsvariablen: siehe `.env.example`.
- Migrationen: `npm run db:migrate` (Tabelle `public.schema_migrations`).
- Mail-Dienst: `MAIL_PROVIDER=brevo` (Standard) oder `postmark`.
  - Brevo Eingang: Empfangs-Subdomain (MX inbound1/2.sendinblue.com), Webhook `type=inbound`, URL `https://<app>/api/inbound/email?token=…`,
    mieter@moovin.de leitet an die Subdomain weiter. Anhänge lädt das System per `BREVO_API_KEY` nach.
  - Brevo Versand: `BREVO_API_KEY`, Absenderdomain moovin.de verifizieren (SPF/DKIM). Reply-To = `INBOUND_ADDRESS`.
- Google-Login: OAuth-Client (Typ Webanwendung) im Google-Cloud-Projekt der Workspace-Organisation, Weiterleitungs-URI
  `https://<app>/api/auth/google/callback`, Zielgruppe „intern“. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` setzen.
- Täglicher Cron (vercel.json, `/api/cron/daily`, `CRON_SECRET`): Hinweise „wartet seit 7 Tagen“, Abwesenheiten, Aufräumen, CRM-Abgleich.
- CRM-Abgleich (Zoho, nur lesend): Self Client, Scopes `ZohoCRM.coql.READ`, `ZohoCRM.modules.deals.READ`, `ZohoCRM.users.READ`;
  Zugang über „Zoho verbinden“ (Seite Objekte, Lese-Token in `settings.zoho_auth`) oder `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`,
  `ZOHO_REFRESH_TOKEN` (EU-Rechenzentrum voreingestellt). COQL auf Abschlüsse der Pipeline
  „Vermietung“, Benutzerliste für Name → Adresse. Code: `src/lib/crm/` (Erkennung und Namensabgleich als reine Funktionen getestet).
- moovin-Anbindung an/aus: `MOOVIN_API_MODE` als Standard, Schalter in der Tabelle `settings` (Admin, Seite „Objekte“) hat Vorrang.
- Tests: `npm run test:e2e` (lokal, Demo-Modus, Testserver für Google, Brevo und Zoho), `npm run api:check` (Konformität moovin-API).
- Löschkonzept (TODO Pilot): täglicher Job löscht geschlossene Tickets > 6 Monate inkl. Anhänge.

## Übergabe an IT (Guido)
1. `docs/moovin-api.openapi.yaml` in app.moovin.de implementieren (Verhalten wie Attrappe `src/app/api/mock-moovin`).
2. Secret austauschen, `MOOVIN_API_URL` auf echte API setzen, moovin-Anbindung unter „Objekte“ wieder einschalten.
3. Attrappe + Schema `mock_moovin` entfernen.
4. Deep-Link in moovin am Bewerber: `https://<app>/tickets?view=offen&email=<adresse>`.
