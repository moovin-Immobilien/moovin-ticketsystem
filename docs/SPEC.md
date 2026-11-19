# moovin Ticketsystem – Anforderungen (SPEC)

Stand: 19.11.2026 · Owner: Fabian Mellin · Umsetzung Prototyp: Fabian + Claude · Anbindung moovin: Guido (IT)

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
| Schreib-Aktionen | Dokumente ablegen, Termin absagen/verschieben, Interesse/Absage setzen, Notiz am Bewerber |
| Absicherung Schreiben | DKIM/DMARC-Prüfung des Absenders. Fehlgeschlagen → keine Aktion, Ticket an AM |
| Auskunft | Status + fehlende Unterlagen + nächste Schritte. **Kein** Score, Ranking, Ablehnungsgrund (AGG) |
| Anhänge | Gar nicht an Claude; ungelesen an moovin |
| Mail-Eingang | Neue Inbound-Adresse/MX → Inbound-Mail-Dienst → Webhook. Zoho Desk fällt weg |
| AM-Zugriff | Eigene Oberfläche, Login mit moovin-Konto (Ziel: Google/M365-SSO), AM sieht seine Objekte; Link aus moovin zum Ticket |
| Wissen | Objektinfos automatisch per API aus moovin, AM ergänzt/prüft. Allgemeine FAQ pflegt Ops zentral |
| Ton | „Sie“, Antwort in der Sprache der eingehenden Mail |
| Zuteilung | AM des Objekts; Vertretung durch Team, sobald überfällig |
| SLA | Menschlich bearbeitete Tickets: Antwort am gleichen Werktag |
| Stack | Next.js auf Vercel, Postgres (Supabase, Region Frankfurt), Claude API |
| API-Auth | HMAC-signierte Requests mit Zeitstempel, Schlüssel rotierbar, jeder Aufruf geloggt; keine IP-Allowlist (feste Ausgangs-IPs kosten bei Vercel extra) |
| Termin verschieben | V1: System bucht nicht selbst um, sondern übermittelt den Verschiebe-Wunsch (+ Absage des alten Slots nur wenn explizit gewünscht) |

## 4. Funktionen

### 4.1 Eingang & Threading
- Webhook `POST /api/inbound/email` (Format: Postmark Inbound JSON; anderer Anbieter = Adapter tauschen).
- Webhook ist per geheimem Token gesichert. Rohdaten werden nicht geloggt.
- Zuordnung zu bestehendem Ticket: (1) `In-Reply-To`/`References` enthält unsere Message-ID, (2) Betreff enthält `[#T-123]`,
  (3) offenes Ticket desselben Absenders < 14 Tage. Sonst neues Ticket.
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
- Dokumente ablegen → `POST /applications/{id}/documents` (Anhänge base64, ungelesen)
- Termin zusagen / absagen / Verschiebewunsch → `POST /appointments/{id}/reply` (`answer` = `zusage` | `absage` | `verschieben`)
- Rückzug, Interesse, sonstige Hinweise → `POST /applications/{id}/notes` (AM setzt den Status in moovin)

Welcher Termin gemeint ist, entscheidet der Server (`src/lib/appointments.ts`): Referenz `[Termin <id>]` im Betreff
(steht in jeder Einladungs-/Erinnerungsmail), sonst einziger offener Termin, sonst eindeutig erwähntes Datum/Adresse/Inserat.
Nicht eindeutig → keine Terminaktion, Rückfrage an den Bewerber.

### 4.6 Oberfläche (AM)
- **Tickets:** Filter Meine / Pool / Überfällig / Alle; Status, Anliegen, Absender, Objekt, Eingang, Fälligkeit.
- **Ticket-Detail:** Verlauf, Bewerber-Kontext live aus moovin, KI-Analyse, editierbarer Entwurf, Aktionen (an/aus),
  „Freigeben & senden“, „Neu generieren“, „Ohne Antwort schließen“, Übernehmen.
- **Wissen:** FAQ (global) und Ergänzungen je Objekt; Objektdaten aus moovin read-only daneben.
- **Autonomie (Admin):** je Intent Anzahl, Quote „unverändert übernommen“, Modus Entwurf/Auto, Schwelle.
- **Simulieren:** Testmail einspielen (für Prototyp und Tests).
- **Audit (Admin):** alle moovin-Aufrufe, KI-Aufrufe (Tokens), Aktionen, Logins.
- Deep-Link aus moovin: `/tickets?email=<adresse>` und `/tickets/<id>`.

### 4.7 Zuteilung & SLA
- Zuständig: AM des Objekts (aus moovin). Unbekannt → Pool.
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
- Rollen: `am`, `admin`. AM sieht eigene Tickets, Pool und Überfällige.
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
- Inbound-Mail-Anbieter final wählen (Vorschlag Postmark, EU-Alternative prüfen) – **kostenpflichtig**.
- SSO (Google Workspace oder M365?) statt Prototyp-Login.
- moovin: Termin-Referenz `[Termin <id>]` in den Betreff der Einladungs- und Erinnerungsmails (Zuordnung bei mehreren Bewerbungen).
- Aufbewahrungsfrist mit Datenschutz abstimmen.
