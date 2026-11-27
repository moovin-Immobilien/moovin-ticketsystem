# moovin Ticketsystem – Anforderungen (SPEC)

Stand: 25.11.2026 · Owner: Fabian Mellin · Umsetzung Prototyp: Fabian + Claude · Anbindung moovin: Guido (IT)

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
| Zuteilung | AM des Objekts (aus moovin, sonst laut CRM über das in der Mail erkannte Objekt); ohne AM → Allgemeiner Eingang. Abwesenheit mit Vertretung (ohne Vertretung → Allgemeiner Eingang). Überfällige sieht das Team |
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
4. Absender in moovin bekannt, 5. bei Schreib-Aktionen: Absender verifiziert (DKIM/DMARC),
6. kein Signal aus Fall C/D der Ticket-Intelligenz (Anmietwunsch, Vertragsphase, Konkurrenz/Frist, Eskalation, kein Handlungsbedarf, 4.12).
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
- **Mein Bereich** (Startseite), fünf Reiter mit Zähler:
  - *Zu erledigen:* Entwürfe zur Freigabe und Handantworten, Überfällige oben.
  - *Offene Aufgaben:* Tabelle `tasks`; **eine Aufgabe je Ticket** als Checkliste – Punkte entstehen bei Verschiebewunsch, Rückzug, Interesse,
    Notiz-Aktion und Signalen (Fall B) und werden an die bestehende Aufgabe angehängt; Abhaken im Ticketsystem.
  - *Wartet auf Bewerber:* Tickets mit Rückfrage (Häkchen beim Senden, von der KI vorbelegt). Antwort des Bewerbers holt sie zurück.
    Nach 7 Tagen ohne Antwort: Aufgabe „nachfassen“ für den AM (täglicher Cron), keine Mail an den Bewerber.
  - *Automatisch erledigt:* Auto-Antworten, Filter nach Anliegen, „gegengelesen“ markieren, Auto-Quote (30 Tage) oben.
  - *Erledigt:* von mir beantwortete oder geschlossene Tickets der letzten 30 Tage (nicht automatische), neueste oben, „Wiedereröffnen“.
- **Allgemeiner Eingang:** alles ohne zuständigen AM (unbekannter Absender, ohne Objekt, nicht zuständig, AM abwesend ohne Vertretung).
  Mit Grund (z. B. „gehört laut CRM zu … – noch nicht freigeschaltet“). Zuordnung per Klick zu Objekt und/oder AM; ohne AM-Auswahl
  übernimmt der AM laut CRM, sonst der AM, der das Objekt zuletzt betreut hat. Audit-Log.
- **Alle Tickets:** Filter Offen / Meine / Allgemeiner Eingang / Wartet / Überfällig / Erledigt.
- **Ticket-Detail:** Verlauf, Bewerber-Kontext live aus moovin, KI-Analyse, editierbarer Entwurf, Aktionen (an/aus),
  „Freigeben & senden“, „Neu generieren“, „Ohne Antwort schließen“, Übernehmen, Zuordnen.
  - Interne Notizen (nie an Bewerber, moovin oder KI) und Weitergabe an Kollegen mit Kommentar.
  - Bearbeitungssperre: Anzeige, wer das Ticket gerade offen hat; Warnung vor dem Senden, wenn inzwischen jemand geantwortet hat.
  - Zusammenführen zweier Tickets desselben Absenders; Verlauf bleibt vollständig.
- **Abwesenheit:** Zeitraum + Vertretung (AM selbst, Admin für alle). Neue und offene Tickets/Aufgaben gehen an die Vertretung,
  ohne Vertretung in den Allgemeinen Eingang. Danach bleiben sie bei der Vertretung; Tickets aus dem Allgemeinen Eingang gehen zurück an den AM.
- **Suche** über alle Tickets (Name, Mailadresse, Objekt, Ticket-Nr.) mit denselben Sichtrechten.
- **Objekte & Zuordnung (Admin, über Team):** Schalter moovin-Anbindung, CRM-Abgleich (Stand, Knopf), AMs laut CRM mit „Freischalten“, Objektsuche.
- **Dashboard (Admin):** Tickets pro Tag/Woche, erste Antwortzeit (Median/90 %), Auto-Quote je Anliegen, offene/überfällige Tickets, offene Aufgaben je AM.
- **Wissen:** FAQ (global) und Ergänzungen je Objekt; Objektdaten aus moovin read-only daneben.
- **Autonomie (Admin):** je Intent Anzahl, Quote „unverändert übernommen“, Modus Entwurf/Auto, Schwelle.
- **Simulieren:** Testmail einspielen (für Prototyp und Tests).
- **Audit (Admin):** alle moovin-Aufrufe, KI-Aufrufe (Tokens), Aktionen, Logins.
- Deep-Link aus moovin: `/tickets?email=<adresse>` und `/tickets/<id>`.

### 4.7 Zuteilung & SLA
- Zuständig: AM des Objekts. Reihenfolge: (1) AM aus der Bewerbung in moovin, (2) AM laut CRM für das Objekt, das in der Mail
  erkannt wird (moovin-ID wie `MV-ABC123`, sonst „Straße Hausnummer“, bei gleicher Adresse in mehreren Orten entscheidet die PLZ;
  auch im zitierten Original). Mehrere Objekte verschiedener AMs → Objekte in Vermarktung haben Vorrang, sonst Allgemeiner Eingang.
- Tickets gehen nur an AMs, die im Ticketsystem freigeschaltet sind; sonst Allgemeiner Eingang mit Hinweis („gehört laut CRM zu …“).
- Unbekannt → Allgemeiner Eingang mit Grund. Abwesend → Vertretung bzw. Allgemeiner Eingang.
- Zuordnung per Klick zu einem Objekt ohne AM-Auswahl: AM laut CRM, sonst der AM, der das Objekt zuletzt betreut hat.
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

### 4.10 Objekt → AM aus dem CRM (Zoho, nur lesend)
- Quelle: Modul „Abschlüsse“, Pipeline „Vermietung“: alle offenen Abschlüsse und abgeschlossene der letzten 60 Tage.
  Felder: `moovin_ID`, Straße, PLZ, Ort, „Zuständiger Account Manager“ (Auswahlliste mit Namen), Kunde, Phase.
- Name → Mailadresse über die CRM-Benutzer (gleicher Nachname und passender Vorname, z. B. „Lillyan-Mia Gehlsen“ → „Lilly Gehlsen“);
  mehrdeutig → keine Zuordnung. Nicht auflösbare Namen zeigt die Seite „Objekte“.
- Abgleich täglich (Cron) und per Knopf (Admin). Zugang: Zoho Self Client mit den Scopes `ZohoCRM.coql.READ`,
  `ZohoCRM.modules.deals.READ`, `ZohoCRM.users.READ`. Einrichten ohne Umweg über Vercel: Admin trägt unter **Objekte** Client ID,
  Client Secret und den erzeugten Code ein („Zoho verbinden“); das System tauscht ihn gegen einen Lese-Token und speichert ihn
  serverseitig (`ticket.settings`, nie im Browser oder Audit-Log). Alternativ `ZOHO_*`-Umgebungsvariablen. Ins CRM wird nie geschrieben.
- Tabelle `ticket.crm_objects`; Objekte, die nicht mehr geliefert werden, bleiben inaktiv erhalten.
- Stand 25.11.2026: ≈ 3.550 Objekte, davon ≈ 1.330 in Vermarktung; ≈ 64 % per Adresse erkennbar (Stellplätze und Objekte ohne Hausnummer nicht),
  bei ≈ 94 % der erkennbaren Adressen ist der AM eindeutig.

### 4.11 Livetest ohne moovin-API (Schalter „moovin-Anbindung“)
- Admin schaltet unter **Team → Objekte & Zuordnung** um (Standard über `MOOVIN_API_MODE`, `an`/`aus`). Hinweisleiste für alle.
- **Aus:** keine Abfragen und keine Schreibaufrufe an moovin, keine Kopie in moovin. Zuordnung nur über das CRM (4.7).
- Die KI arbeitet ohne Bewerberdaten: Sie schreibt nie, die Adresse sei unbekannt, nennt keine persönlichen Angaben (Stand, Termin,
  Treffpunkt) und setzt keine Platzhalter – sie formuliert neutral und versandfertig (z. B. Verweis auf Profil/Login), der AM prüft den
  Entwurf (`needs_human`). Allgemeine Fragen beantwortet sie wie sonst.
- Vorgeschlagene Aktionen (Unterlagen, Termin bestätigen/absagen, Rückzug, Interesse, Notiz) gehen nicht an moovin, sondern werden
  nach der Freigabe zu **Aufgaben** für den AM; der Verschiebewunsch geht wie immer per Mail an den AM.
- Antworten gehen an die Absenderadresse (es gibt keine hinterlegte Adresse aus moovin); persönliche Angaben ergänzt der AM nur nach Prüfung in moovin.
  Der Entwurf behauptet nie, etwas sei in moovin vermerkt oder erledigt; „geben wir weiter“/„legen wir ab“ nur für Punkte, die der AM beim Freigeben als Aufgabe erledigt.
- Auto-Versand nur für allgemeine Anliegen (Wohnungssuche, Datenschutz, Login) und nie mit Aufgabe.
- **An:** Verhalten wie zuvor; das CRM ergänzt nur, wenn moovin keinen AM liefert.
- Antwortstil ohne moovin-API (Feedback-Paket 2): Die Antwort ist eine Wegweisung, kein Vermerk – Termine zu-/absagen über den Link in der
  Einladungsmail, Mietinteresse über den Button in der Mail „Wollen Sie die Wohnung mieten?“, Unterlagen/Stand/Löschung im Login, Fragen zur
  Wohnung über das Exposé, Eigentümer über das Kontaktformular moovin.de/vermieten. „Geben wir weiter“ nur bei Unterlagen, Anmietwunsch/Frist,
  Rückzug und Beschwerde (dort entsteht die eine Aufgabe für den AM); kein „Ihr Ansprechpartner meldet sich“ als Fallback. Jede Antwort endet
  mit dem Hinweis auf den Login. Bei Datenschutz-Anliegen geht die Antwort mit datenschutz@moovin.de in Kopie (`messages.cc_email`), die
  separate Weiterleitung entfällt.


### 4.12 Ticket-Intelligenz: Chancen erkennen, richtig sortieren
Konzept: `claude/ticket-intelligenz.md` im Projekt. Grundsatz: **Priorisiert wird der Vorgang, nie die Person** (keine Signale zu Einkommen,
Bonität, Herkunft o. Ä.; unbekannte Werte verwirft der Server).
- Claude liefert im strukturierten Ergebnis `signals` (feste Werte + Beleg-Zitat + ggf. Frist): `unterlagen_eingegangen`,
  `zusage_nach_besichtigung`, `vertragsphase`, `konkurrenz_frist`, `termin_bald`, `rueckzug_spaet`, `eskalation`, `kein_handlungsbedarf`.
  Demo-Modus: Stichwortregeln. Kein zusätzlicher KI-Aufruf.
- Der Server (`src/lib/signals.ts`) bestätigt mit Daten und setzt die **Stufe** (nie das Modell):
  - Stufe 1 Abschluss-Chance: Unterlagen nach Besichtigung oder alle fehlenden Unterlagenarten geschickt (Dateinamen ↔ `missing_documents`),
    Anmietwunsch nach Besichtigung, Vertragsphase (beim Eigentümer/Zusage), Konkurrenzangebot/Frist (aktive Bewerbung).
  - Stufe 2 zeitkritisch: Termin in < 48 h (Termin aus moovin), Rückzug in später Phase, Eskalation, ≥ 2 Mails ohne Antwort.
  - Stufe 4: kein Handlungsbedarf (nur ohne Anhang, Aktion und anderes Signal) und System-Benachrichtigungen.
  - Ohne Bestätigung nur Hinweis (Stufe 3). moovin-Anbindung aus: Signal gilt „laut Mail“ (gestrichelt), Stufe bleibt.
- Automatisch bearbeitete Tickets: **Fall B** (Unterlagen, Absage < 48 h, später Rückzug) → Auto-Antwort erlaubt, dazu markierte
  Aufgabe ganz oben („Unterlagen prüfen“, „Slot nachbesetzen“, „Nächsten Kandidaten aktivieren“); bei Freigabe durch den AM wird eine
  passende Aufgabe hochgestuft. **Fall C** (Anmietwunsch, Vertrag, Frist, Eskalation) → nie automatisch. **Fall D** („Danke, bis Montag“) → kurzer Entwurf
  mit Login-Hinweis, unten mit „Ohne Antwort schließen“. Spam und Systemmails (Bounce, Abwesenheitsnotiz, Newsletter) werden bei der ersten
  Mail eines Tickets **automatisch geschlossen** (`auto_closed`, Audit `automatisch_geschlossen`), tauchen in keiner Arbeitsliste auf und öffnen
  sich bei einer echten Antwort wieder; Eskalation zählt nur bei Anliegen, für die moovin zuständig ist.
- Sortierung in „Zu erledigen“ und „Offene Aufgaben“: Stufe 1 → Stufe 2 → Überfällige → Fälligkeit → Stufe 4. Farbbalken, Zeile
  „Warum oben?“ mit Beleg, Zähler/Filter „Chancen“, Karte „Ticket-Intelligenz“ im Ticket mit „Markierung passt nicht“.
- SLA nach Stufe: Stufe 1 in 2, Stufe 2 in 4 Arbeitsstunden (Mo–Fr 8–18 Uhr); Frist im Text → fällig am Vortag 12 Uhr.
- Stufe 1/2 entfällt, sobald das Ticket beantwortet oder geschlossen ist.
- Autonomie-Seite: Trefferquote je Signal (60 Tage) aus „Markierung passt nicht“, Signale abschaltbar (`settings.signals_off`).
- Dashboard: offene Chancen je AM, Chancen älter als 2 h, Reaktionszeit Stufe 1, Anteil in ≤ 2 h, Chance → Zusage (Status `zusage` bei
  späterem Kontakt), offene Eskalationen.
- Daten: Migration 010 (`tickets.priority`, `tickets.signals`, `chance_*`, `tasks.priority`, `signal_feedback`). Keine Änderung an der moovin-API.

## 5. Sicherheit & Datenschutz
- Hosting EU (Vercel Region `fra1`, Postgres Frankfurt). AVV mit Anthropic, Zero-Data-Retention anfragen.
- Datenminimierung: Claude sieht nur den Ausschnitt zum Absender; keine Anhänge, kein Score.
- Secrets nur als Umgebungsvariablen, nie im Code/Chat.
- Rollen: `am`, `admin`. AM sieht eigene Tickets, Allgemeinen Eingang und Überfällige (auch in der Suche).
- Keine proaktiven Mails an Bewerber, keine Massen-Freigabe; Eingriffe in moovin nur über die fünf API-Aufrufe.
- CRM (Zoho) nur lesend, nur Abschlüsse der Vermietung und Benutzernamen/-adressen; Kundennamen sieht nur das Team, nie die KI.
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
- Zoho verbinden (einmalig, ca. 3 Minuten): api-console.zoho.eu → Self Client → Code mit den Lese-Scopes aus 4.10 erzeugen →
  unter **Team → Objekte & Zuordnung** eintragen. Rechenzentrum EU ist voreingestellt (`ZOHO_ACCOUNTS_URL`).
- Google-OAuth-Client (Google Cloud, Workspace moovin.de) anlegen: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` setzen.
  Bis dahin gilt übergangsweise das Prototyp-Passwort; mit Google-Zugangsdaten ist es automatisch abgeschaltet.
- Brevo einrichten (Tarif klären): Empfangs-Subdomain (z. B. reply.moovin.de, MX auf Brevo), Weiterleitung mieter@ → Subdomain,
  Inbound-Webhook auf `/api/inbound/email?token=…`, `BREVO_API_KEY`, Absenderdomain moovin.de verifizieren, `TRUSTED_AUTHSERV_IDS` prüfen.
- Aufbewahrungsfrist mit Datenschutz abstimmen.
