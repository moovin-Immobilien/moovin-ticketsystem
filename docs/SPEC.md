# moovin Ticketsystem – Anforderungen (SPEC)

Stand: 24.11.2026 · Owner: Fabian Mellin · Umsetzung Prototyp: Fabian + Claude · Anbindung moovin: Guido (IT)

## 1. Ziel

Mails von Interessenten/Bewerbern (heute mieter@moovin.de → Zoho Desk) werden in einem eigenen, KI-gestützten
Ticketsystem bearbeitet. Claude beantwortet Anliegen auf Basis einer Wissensdatenbank und Live-Infos aus moovin
(app.moovin.de) und löst einfache Aktionen in moovin aus. Zoho Desk wird nach dem Pilot abgeschaltet.

**Leitplanken (nicht verhandelbar)**

1. Claude läuft nur im Ticketsystem. Claude hat **keinen** Zugriff auf die moovin-Datenbank.
2. moovin stellt eine **schmale, zweckgebundene API** bereit (siehe `docs/moovin-api.openapi.yaml`). Schlüssel ist die Mailadresse.
3. Das Ticketsystem entscheidet, welche Daten Claude sieht und welche Aktionen erlaubt sind – nie das Modell.
4. Anhänge (Gehaltsnachweis, Schufa, Ausweis …) gehen **nie** an Claude. Sie werden ungelesen an moovin weitergereicht.
5. Antworten gehen **immer an die in moovin hinterlegte Adresse**, nie an Reply-To.
6. Schnell, sicher, einfach: lieber wenige robuste Funktionen als viele halbe.

## 2. Zielgruppe & Scope

- **In Scope:** Interessenten und Bewerber (Fragen zu Besichtigung, Bewerbungsstand, Unterlagen, Objekt, Absagen).
- **Out of Scope (V1):** Bestandsmieter, Kunden/Eigentümer, Dienstleister. Solche Mails werden als „nicht zuständig“
  erkannt und an einen Menschen gegeben.

## 3. Entscheidungen (aus Abstimmung 18.11.2026)

| Thema | Entscheidung |
|---|---|
| Architektur | Eigenständiges Ticketsystem mit eigener Oberfläche, moovin per API angebunden |
| Autonomie | Stufenweise: Start mit Entwürfen + Freigabe durch AM. Je Anliegen (Intent) auf Auto-Antwort schalten, sobald ≥ 90 % der Entwürfe unverändert rausgehen |
| Schreib-Aktionen | Dokumente ablegen, Termin zusagen/absagen, Notiz am Bewerber (Rückzug, Interesse), optional Kopie je Nachricht |
| Absicherung Schreiben | DKIM/DMARC-Prüfung des Absenders. Fehlgeschlagen → keine Aktion, Ticket an AM |
| Auskunft | Status + fehlende Unterlagen + nächste Schritte. **Kein** Score, Ranking, Ablehnungsgrund (AGG) |
| Anhänge | Gar nicht an Claude; ungelesen an moovin |
| Mail-Eingang/-Versand | Brevo (Inbound Parsing + Transaktionsmails); Postmark-Adapter bleibt, umschaltbar per `MAIL_PROVIDER`. Zoho Desk fällt weg |
| AM-Zugriff | Eigene Oberfläche, nur Google-Login (Workspace-Domain moovin.de, Scopes openid/email/profile). Unbekannte moovin-Adressen erst nach Freischaltung durch Admin |
| Wissen | Objektinfos automatisch per API aus moovin, AM ergänzt/prüft. Allgemeine FAQ pflegt Ops zentral |
| Ton | „Sie“, Antwort in der Sprache der eingehenden Mail |
| Zuteilung | AM des Objekts; ohne AM → Allgemeiner Eingang. Abwesenheit mit Vertretung (ohne Vertretung → Allgemeiner Eingang). Überfällige sieht das Team |
| SLA | Menschlich bearbeitete Tickets: Antwort am gleichen Werktag |
| Stack | Next.js auf Vercel, Postgres (Supabase, Region Frankfurt), Claude API |
| API-Auth | HMAC-signierte Requests mit Zeitstempel, Schlüssel rotierbar, jeder Aufruf geloggt; keine IP-Allowlist (feste Ausgangs-IPs kosten bei Vercel extra) |
| Termin verschieben | V1: System bucht nicht selbst um; der Verschiebewunsch geht per Mail an den zuständigen AM (kein API-Aufruf, Abstimmung mit Guido 20.11.2026) |

## 4. Funktionen

### 4.1 Eingang & Threading
- Webhook `POST /api/inbound/email`. Format nach `MAIL_PROVIDER`: `brevo` (Standard, Inbound Parsing `{items:[…]}`) oder `postmark`.
  Brevo-Anhänge werden über den DownloadToken per API geladen; schlägt das fehl → Hinweis am Ticket, Mensch nötig.
- Webhook ist per geheimem Token gesichert (`?token=`, Basic oder Bearer). Rohdaten werden nicht geloggt.
- Zuordnung zu bestehendem Ticket: (1) `In-Reply-To`/`References` enthält unsere oder die vom Versanddienst vergebene Message-ID,
  (2) Betreff enthält `[#T-123]`, (3) offenes Ticket desselben Absenders < 14 Tage. Sonst neues Ticket.
- Antwort auf ein geschlossenes Ticket (über 1 oder 2) öffnet es wieder (Notiz + Audit). Zusammengeführte Tickets leiten weiter.
- Versand: Brevo vergibt die Message-ID selbst (Standard-Header nicht setzbar) → wird gespeichert; Reply-To = mieter@.
- Absenderprüfung: `Authentication-Results` → `dkim=pass` mit Domain-Alignment **oder** `dmarc=pass` ⇒ `verifiziert`.

### 4.2 KI-Verarbeitung (Claude)
- Modell: `claude-sonnet-5-5` (konfigurierbar), structured output (JSON-Schema).
- Claude bekommt: Mailtext (ohne Anhänge, nur Dateinamen/Typ), bisherigen Verlauf, und **Werkzeuge**, die serverseitig an
  den identifizierten Bewerber gebunden sind (Claude kann keine fremde Mailadresse abfragen):
  - `get_application_status` – Bewerbungen, Status, fehlende Unterlagen, Termine dieses Absenders
  - `get_object_info` – öffentliche Inseratsdaten (nur Inserate, auf die sich der Absender beworben hat)
  - `search_knowledge` – Wissensdatenbank (FAQ + Objekt-Ergänzungen)
- Ergebnis: Intent, Sprache, Konfidenz, Zusammenfassung, Antwortentwurf, vorgeschlagene Aktionen, `needs_human` + Grund.
- Ohne API-Key läuft ein **Demo-Modus** (regelbasiert), damit die Oberfläche testbar bleibt.

### 4.3 Intents (Anliegen)
`bewerbungsstatus`, `unterlagen_nachreichen`, `termin_bestaetigen`, `termin_absage`, `termin_verschieben`, `besichtigung_frage`, `objekt_frage`,
`interesse_bestaetigen`, `rueckzug`, `beschwerde`, `nicht_zustaendig`, `intern_system`, `sonstiges`, `spam`.
`beschwerde`, `nicht_zustaendig`, `intern_system`, `sonstiges` sind **immer** menschlich (nicht auf Auto schaltbar).

### 4.4 Autonomie-Logik
Auto-Versand nur wenn **alle** Bedingungen erfüllt:
1. Intent steht auf `auto`, 2. Konfidenz ≥ Schwelle (Default 0,85), 3. `needs_human = false`,
4. Absender in moovin bekannt, 5. bei Schreib-Aktionen: Absender verifiziert (DKIM/DMARC).
Sonst: Entwurf → Freigabe-Queue des zuständigen AM.

### 4.5 Aktionen in moovin
Ausgeführt bei Freigabe durch AM (oder im Auto-Modus). Jede Aktion ist idempotent (`Idempotency-Key` = Ticket-ID + Aktion).
- Dokumente ablegen → `POST /applicants/{id}/documents` (im Bewerberprofil, gilt für alle Bewerbungen; Anhänge base64, ungelesen)
- Termin zusagen / absagen → `POST /appointments/{id}/reply` (`answer` = `zusage` | `absage`)
- Verschiebewunsch → kein moovin-Aufruf: das Ticketsystem mailt den Wunsch direkt an den zuständigen AM
- Rückzug, Interesse, sonstige Hinweise → `POST /applications/{id}/notes` (AM setzt den Status in moovin)

Welcher Termin gemeint ist, entscheidet der Server (`src/lib/appointments.ts`): einziger offener Termin, sonst eindeutig
erwähntes Datum/Uhrzeit, Adresse oder Inserat. (Keine Termin-Kennung in Mails – moovin-Termin-IDs sind intern.)
Nicht eindeutig → keine Terminaktion, Rückfrage an den Bewerber.

### 4.6 Oberfläche (AM)
- **Login:** nur Google (Workspace moovin.de, `hd`-Prüfung, PKCE, Nonce). Erstanmeldung unbekannter Adresse → Antrag, Admin schaltet unter **Team** frei.
- **Mein Bereich** (Startseite), vier Reiter mit Zähler:
  - *Zu erledigen:* Entwürfe zur Freigabe und Handantworten, Überfällige oben.
  - *Offene Aufgaben:* Tabelle `tasks`; automatisch bei Verschiebewunsch, Rückzug, Interesse und jeder Notiz-Aktion; Abhaken im Ticketsystem.
  - *Wartet auf Bewerber:* Tickets mit Rückfrage (Häkchen beim Senden, von der KI vorbelegt). Antwort des Bewerbers holt sie zurück.
    Nach 7 Tagen ohne Antwort: Aufgabe „nachfassen“ für den AM (täglicher Cron), keine Mail an den Bewerber.
  - *Automatisch erledigt:* Auto-Antworten, Filter nach Anliegen, „gegengelesen“ markieren, Auto-Quote (30 Tage) oben.
- **Allgemeiner Eingang:** alles ohne zuständigen AM (unbekannter Absender, ohne Objekt, nicht zuständig, AM abwesend ohne Vertretung).
  Zuordnung per Klick zu Objekt und/oder AM; ohne AM-Auswahl übernimmt der AM, der das Objekt zuletzt betreut hat. Audit-Log.
- **Alle Tickets:** Filter Offen / Meine / Allgemeiner Eingang / Wartet / Überfällig / Erledigt.
- **Ticket-Detail:** Verlauf, Bewerber-Kontext live aus moovin, KI-Analyse, editierbarer Entwurf, Aktionen (an/aus),
  „Freigeben & senden“, „Neu generieren“, „Ohne Antwort schließen“, Übernehmen, Zuordnen.
  - Interne Notizen (nie an Bewerber, moovin oder KI) und Weitergabe an Kollegen mit Kommentar.
  - Bearbeitungssperre: Anzeige, wer das Ticket gerade offen hat; Warnung vor dem Senden, wenn inzwischen jemand geantwortet hat.
  - Zusammenführen zweier Tickets desselben Absenders; Verlauf bleibt vollständig.
- **Abwesenheit:** Zeitraum + Vertretung (AM selbst, Admin für alle). Neue und offene Tickets/Aufgaben gehen an die Vertretung,
  ohne Vertretung in den Allgemeinen Eingang. Danach bleiben sie bei der Vertretung; Tickets aus dem Allgemeinen Eingang gehen zurück an den AM.
- **Suche** über alle Tickets (Name, Mailadresse, Objekt, Ticket-Nr.) mit denselben Sichtrechten.
- **Dashboard (Admin):** Tickets pro Tag/Woche, erste Antwortzeit (Median/90 %), Auto-Quote je Anliegen, offene/überfällige Tickets, offene Aufgaben je AM.
- **Wissen:** FAQ (global) und Ergänzungen je Objekt; Objektdaten aus moovin read-only daneben.
- **Autonomie (Admin):** je Intent Anzahl, Quote „unverändert übernommen“, Modus Entwurf/Auto, Schwelle.
- **Simulieren:** Testmail einspielen (für Prototyp und Tests).
- **Audit (Admin):** alle moovin-Aufrufe, KI-Aufrufe (Tokens), Aktionen, Logins.
- Deep-Link aus moovin: `/tickets?email=<adresse>` und `/tickets/<id>`.

### 4.7 Zuteilung & SLA
- Zuständig: AM des Objekts (aus moovin). Unbekannt → Allgemeiner Eingang. Abwesend → Vertretung bzw. Allgemeiner Eingang.
- Tickets „wartet auf Bewerber“ haben keine Fälligkeit; die Antwort des Bewerbers setzt sie neu.
- Fälligkeit: Eingang an Werktag vor 16:00 → 18:00 desselben Tages; sonst nächster Werktag 12:00 (Europe/Berlin).
- Überfällige Tickets sieht das ganze Team.

### 4.8 KPIs
Erste Antwortzeit, Anteil Auto-Antworten, Quote unverändert übernommener Entwürfe je Intent, Eskalationen,
Anzahl Termin-Absagen (→ No-Show-Effekt), offene/überfällige Tickets.

## 4.9 Erkenntnisse aus dem Zoho-Desk-Export (01.06.–18.11.2026, 4.720 Tickets)
- Volumen: Ø 28 Tickets/Tag, seit KW 43 stark gestiegen (≈ 400–450/Woche, ≈ 80–90 je Werktag). Nov.: 987 von 1.135 Tickets offen.
- ~30 % sind Antworten auf moovins automatische Termin-Mails („Rückmeldung erforderlich“, „Bestätigung“, „Erinnerung“, „Terminabsage“) → größter Hebel: Termin bestätigen/absagen/verschieben automatisieren.
- ~18 % System-/interne Absender (no-reply@moovin.de, @moovin.de, ImmoScout-Benachrichtigungen) → werden ohne KI direkt an Menschen gegeben.
- ~7 % Unterlagen/Selbstauskunft, ~6 % Status/Absage, ~3 % Mietangebot; ~17 % ohne aussagekräftigen Betreff.
- Export enthält kaum Mailtexte (nur 294 Beschreibungen) → Feinschliff der Antworten mit echten Mails im Pilot (Schattenbetrieb).

## 5. Sicherheit & Datenschutz
- Hosting EU (Vercel Region `fra1`, Postgres Frankfurt). AVV mit Anthropic, Zero-Data-Retention anfragen.
- Datenminimierung: Claude sieht nur den Ausschnitt zum Absender; keine Anhänge, kein Score.
- Secrets nur als Umgebungsvariablen, nie im Code/Chat.
- Rollen: `am`, `admin`. AM sieht eigene Tickets, Allgemeinen Eingang und Überfällige (auch in der Suche).
- Keine proaktiven Mails an Bewerber, keine Massen-Freigabe; Eingriffe in moovin nur über die fünf API-Aufrufe.
- Audit-Log unveränderlich (insert-only).
- Löschkonzept: geschlossene Tickets + Anhänge nach 6 Monaten löschen (analog Bewerberdaten), konfigurierbar.
- Prompt-Injection: Mailinhalt ist Daten, nicht Anweisung. Werkzeuge sind an den Absender gebunden; Aktionen erst nach
  serverseitiger Prüfung; Claude kann keine Mail an andere Empfänger auslösen.

## 6. Phasen
1. Konzept + Prototyp mit Attrappe der moovin-API (dieses Repo)
2. Test mit echten Mails aus Zoho-Desk-Export (Replay), Prompt-Feinschliff, Messung
3. Guido: echte moovin-API nach `docs/moovin-api.openapi.yaml` (alle fünf Aufrufe in einem Schritt), Security-Review
4. Pilot mit 1–2 AMs, danach Umstellung mieter@ und Abschaltung Zoho Desk

## 7. Offene Punkte
- Google-OAuth-Client (Google Cloud, Workspace moovin.de) anlegen: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` setzen.
  Bis dahin gilt übergangsweise das Prototyp-Passwort; mit Google-Zugangsdaten ist es automatisch abgeschaltet.
- Brevo einrichten (Tarif klären): Empfangs-Subdomain (z. B. reply.moovin.de, MX auf Brevo), Weiterleitung mieter@ → Subdomain,
  Inbound-Webhook auf `/api/inbound/email?token=…`, `BREVO_API_KEY`, Absenderdomain moovin.de verifizieren, `TRUSTED_AUTHSERV_IDS` prüfen.
- Aufbewahrungsfrist mit Datenschutz abstimmen.
