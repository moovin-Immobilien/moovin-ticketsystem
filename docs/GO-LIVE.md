# Go-Live: Schritt für Schritt

Stand: 25.11.2026 · Owner: Fabian Mellin · App: https://moovin-ticketsystem.vercel.app

Ziel: Mails an mieter@moovin.de laufen ins Ticketsystem, zuerst mit 1–2 Pilot-AMs, dann für alle. Zoho Desk wird abgeschaltet.
Die moovin-API (Guido) ist **keine** Voraussetzung: Der Start läuft mit **moovin-Anbindung „aus“** (Zuordnung über das CRM,
Aktionen werden Aufgaben). Sobald Guidos API steht, wird sie zugeschaltet (Phase 5).

Rückweg jederzeit: Weiterleitung von mieter@ an das Ticketsystem entfernen. Zoho Desk läuft bis Phase 4 parallel weiter.

---

## Phase 0 · Voraussetzungen (einmalig, ca. 1–2 Tage inkl. IT)

| # | Schritt | Wer | Dauer | Kosten |
|---|---|---|---|---|
| 0.1 | **AVV mit Anthropic** abschließen und Zero-Data-Retention anfragen; Aufbewahrungsfrist (Vorschlag 6 Monate) mit Datenschutz abstimmen. Vorher keine echten Bewerbermails ins System. | Fabian / Datenschutz | – | – |
| 0.2 | **Zoho verbinden**: api-console.zoho.eu → Self Client → *Generate Code*, Scopes `ZohoCRM.coql.READ,ZohoCRM.modules.deals.READ,ZohoCRM.users.READ`, Dauer 10 Min. → in der App unter **Team → Objekte & Zuordnung** Client ID, Client Secret und Code eintragen → *Verbinden*. Prüfen: ≈ 3.500 Objekte, Liste „AMs laut CRM“. | Fabian | 3 Min. | – |
| 0.3 | **Google-Login**: Google Cloud Console (Projekt der Workspace-Organisation) → APIs & Dienste → OAuth-Zustimmungsbildschirm *Intern* → Anmeldedaten → OAuth-Client *Webanwendung*, Weiterleitungs-URI `https://moovin-ticketsystem.vercel.app/api/auth/google/callback`. Client ID und Secret in Vercel als `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (sensitive, Production) eintragen, neu deployen. Danach ist das Prototyp-Passwort automatisch aus; `PROTOTYPE_PASSWORD` löschen. | IT (Workspace-Admin) + Fabian | 15 Min. | – |
| 0.4 | **Vercel-Schutz**: Projekt → Settings → Deployment Protection → für *Production* ausschalten (Preview geschützt lassen). Sonst brauchen AMs ein Vercel-Konto und der Brevo-Webhook kommt nicht durch. Die App hat ihren eigenen Login. | Fabian | 2 Min. | – |
| 0.5 | **Vercel-Tarif prüfen**: Für den geschäftlichen Betrieb ist ein Pro-Tarif nötig, falls das Team noch auf Hobby läuft. | Fabian | – | ggf. ja |
| 0.6 | **Brevo** (Tarif mit Inbound Parsing wählen): Konto anlegen → Absenderdomain **moovin.de** authentifizieren (DKIM/SPF/DMARC-Einträge setzt die IT im DNS) → API-Schlüssel erzeugen → in Vercel `BREVO_API_KEY` (sensitive). | Fabian + IT | 30 Min. + DNS-Wartezeit | ja (Tarif) |
| 0.7 | **Empfangs-Subdomain**: IT setzt für `reply.moovin.de` MX-Einträge auf `inbound1.sendinblue.com` (Prio 10) und `inbound2.sendinblue.com` (Prio 20). In Brevo Inbound-Webhook anlegen: Typ *inbound*, Domain `reply.moovin.de`, URL `https://moovin-ticketsystem.vercel.app/api/inbound/email?token=<INBOUND_WEBHOOK_TOKEN>` (Wert in Vercel unter Environment Variables einsehen). | IT + Fabian | 15 Min. + DNS | – |
| 0.8 | **Claude-Budget**: `CLAUDE_MONTHLY_BUDGET_USD` steht auf 50 $. Bei ≈ 1.800 Mails/Monat reicht das voraussichtlich nicht; für den Pilot 150 $ setzen (harte Grenze, danach Regelbetrieb ohne KI). | Fabian | 1 Min. | ja (Verbrauch) |
| 0.9 | **Test-Mail**: von einer privaten Adresse an `test@reply.moovin.de` schreiben → Ticket erscheint im Allgemeinen Eingang, Anhang wird geladen, Antwort kommt an (Absender mieter@moovin.de, DKIM ok). | Fabian | 10 Min. | – |

## Phase 1 · Einstellungen in der App (ca. 30 Min.)

1. **Team**: Pilot-AMs (1–2) unter *Objekte & Zuordnung → AMs laut CRM* mit **Freischalten** aktivieren; Teamleitung als Admin.
2. **Objekte & Zuordnung**: Schalter **moovin-Anbindung: aus** (ist gesetzt). CRM-Abgleich läuft täglich, Knopf *Jetzt abgleichen* für sofort.
3. **Autonomie**: alle Anliegen auf **Entwurf** lassen (Standard). Keine Auto-Antworten im Pilot-Start.
4. **Wissen**: FAQ kurz gegenlesen (Unterlagen, Ablauf, Datenschutz, Login, Suchagent); Objekt-Ergänzungen für Pilot-Objekte (Parken, Haustiere, Treffpunkt).
5. Pilot-AMs: einmal mit Google anmelden, **Mein Bereich** ansehen, Abwesenheit/Vertretung eintragen.

## Testphase · Testbatterie (vor Phase 2, beliebig wiederholbar)

Feste Testfälle (44 Mails, `src/lib/testbatterie.json`) laufen wie echte Mails durch das System – mit echten Objekten aus dem CRM, echter
Zuordnung und echtem Claude –, aber als **Testtickets**: Für Testtickets geht **nie** eine Mail raus (weder an Bewerber noch an AMs oder
datenschutz@), es gibt keinen Auto-Versand und keine Schreibaufrufe an moovin. Zusätzlich gilt für alle Tickets: An reservierte Testdomains
(example.com/.org/.net, *.test, *.invalid, *.local, *.example) wird nie versendet.

1. **Testmail → Abschnitt „Testbatterie“** (nur Admin): Fälle auswählen (Standard: alle) → *Testbatterie laden*. Je Fall ein Aufruf
   (ca. 10–40 s), 3 parallel, Fortschritt und Fehler je Fall werden angezeigt; Folgemails laufen nach ihrem Vorgänger.
   Kosten je Lauf ≈ 44 Claude-Aufrufe, grob 2–4 $.
2. **Testbericht** (`/simulieren/bericht?run=…`, Link nach dem Lauf): je Fall Soll gegen Ist – Anliegen, Stufe, Signale, Fall B/C/D,
   Zuordnung (Quelle, AM), Sprache, Auto, [AM: …]-Platzhalter, Aktion. Abweichungen rot, oben die Trefferquote für Anliegen und Stufe.
   „Prüfen“-Hinweise (z. B. „keine fremden Daten, kein Score“) im Entwurf von Hand ansehen.
3. Testtickets tragen das Badge **TEST**, zählen in keiner Kennzahl und sind für AMs ausgeblendet (Schalter „TEST ein/aus“ oben rechts).
   Sie dürfen bei AMs landen (die Zuordnung wird mitgetestet). Im Ticket kann man „Freigeben & senden“ gefahrlos ausprobieren: Status „simuliert“.
4. Prompt, Wissen oder Signale angepasst? Neuen Lauf starten und die Trefferquoten der Läufe vergleichen.
5. **Aufräumen**: *Testtickets löschen* (je Lauf oder alle, mit Bestätigung) – entfernt Tickets samt Nachrichten, Entwürfen, Aktionen,
   Aufgaben, Notizen, Anhängen und Signal-Rückmeldungen. Das Audit-Log bleibt (insert-only).
6. Einzelne Testmails über das Formular darüber sind standardmäßig ebenfalls Testtickets (Haken „Als Testticket“).

## Phase 2 · Schattenbetrieb (1 Woche)

1. **Google Workspace** (Admin-Konsole → Gmail → Routing): Für mieter@moovin.de eine Regel *zusätzlicher Empfänger* `mieter@reply.moovin.de`. Zoho Desk bekommt weiter alles.
2. AMs **antworten weiter in Zoho Desk**. Im Ticketsystem nur prüfen: Stimmen Zuordnung, Entwurf, Markierung („Warum oben?“)?
   Dort **nicht senden**, sondern *Ohne Antwort schließen*. Falsche Markierung → *Markierung passt nicht*.
3. Täglich 10 Min. (Fabian): Allgemeiner Eingang (warum ohne AM?), Dashboard, Autonomie-Seite (Trefferquote je Signal).
4. **Go/No-Go am Ende der Woche**:
   - ≥ 80 % der Pilot-Tickets dem richtigen AM zugeordnet
   - Entwürfe überwiegend brauchbar (AM-Einschätzung)
   - keine falsche Stufe-1-Markierung, die ernsthaft gestört hat
   - keine Fehler im Audit-Log / bei Vercel

## Phase 3 · Pilot live (2 Wochen)

1. Pilot-AMs **antworten im Ticketsystem** (Freigeben & senden). Tickets ihrer Objekte in Zoho Desk ohne Antwort schließen.
2. Tickets anderer AMs landen im Allgemeinen Eingang („gehört laut CRM zu … – noch nicht freigeschaltet“) und werden weiter in Zoho Desk bearbeitet; im Ticketsystem täglich gesammelt schließen.
3. Reihenfolge für AMs: **Chancen** zuerst (grün), dann zeitkritisch (orange), dann Überfällige. Aufgaben in *Offene Aufgaben* in moovin erledigen und abhaken.
4. Nach ≥ 20 Fällen je Anliegen mit ≥ 90 % unverändert: auf der Autonomie-Seite auf **Auto** stellen (ohne moovin-API zunächst nur allgemeine Anliegen: Wohnungssuche, Datenschutz, Login).
5. Kennzahlen wöchentlich: erste Antwortzeit, Reaktion Stufe 1 (Ziel ≤ 2 h), Auto-Quote, offene Aufgaben.

## Phase 4 · Rollout auf alle AMs und Abschalten von Zoho Desk

1. Alle AMs freischalten (Objekte & Zuordnung → *Freischalten*), kurze Einweisung (15 Min., Mein Bereich + Chancen + Aufgaben).
2. Weiterleitung umstellen: mieter@moovin.de geht **nur noch** an `mieter@reply.moovin.de` (Zoho Desk raus).
3. Zoho Desk 2 Wochen lesend behalten, offene Altfälle dort abarbeiten, dann abschalten.

## Phase 5 · moovin-API zuschalten (wenn Guido fertig ist)

1. Guido setzt `docs/moovin-api.openapi.yaml` um; `npm run api:check` gegen seine URL muss 27/27 bestehen.
2. In Vercel: `MOOVIN_API_URL`, `MOOVIN_API_KEY_ID`, `MOOVIN_API_SECRET` (neu, rotiert) setzen, neu deployen.
3. Unter **Objekte & Zuordnung** moovin-Anbindung **einschalten**. Ab dann: Bewerberdaten live, Aktionen direkt in moovin, Antwort an die in moovin hinterlegte Adresse.
4. Attrappe und Schema `mock_moovin` entfernen; Anthropic-Schlüssel nach der Testphase rotieren.

---

## Wer macht was

| Rolle | Aufgaben |
|---|---|
| Fabian | 0.1–0.6, 0.8–0.9, Phase 1, tägliche Kontrolle, Go/No-Go |
| IT / Workspace-Admin | Google-OAuth-Client (0.3), DNS für Brevo und reply.moovin.de (0.6, 0.7), Gmail-Routing (Phase 2/4) |
| Pilot-AMs | Schattenbetrieb bewerten, Markierungen rückmelden, ab Phase 3 im Ticketsystem antworten |
| Guido | moovin-API (Phase 5) |

## Wenn etwas schiefgeht

- **Mails kommen nicht an**: Brevo → Inbound-Logs; Vercel → Runtime-Logs `/api/inbound/email` (401 = falscher Token).
- **Antworten kommen nicht an**: Brevo → Transaktions-Logs; Absenderdomain authentifiziert? Bis dahin zeigt das Ticket „Versand simuliert“.
- **Falscher AM**: im Ticket *Zuordnen*; Ursache meist veralteter AM im CRM → im CRM korrigieren, Abgleich läuft nachts.
- **Sofort zurück**: Gmail-Routing-Regel für reply.moovin.de deaktivieren – Zoho Desk bekommt weiter alle Mails.
