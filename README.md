# moovin Ticketsystem (Prototyp)

KI-gestütztes Ticketsystem für Mails von Mietinteressenten an mieter@moovin.de – ersetzt Zoho Desk.
Claude beantwortet Anliegen auf Basis einer Wissensdatenbank und Live-Daten aus moovin (über eine schmale,
signierte API) und löst einfache Aktionen aus (Termin zu-/absagen, Unterlagen ablegen, Notizen).
AMs arbeiten in „Mein Bereich“ (Zu erledigen, Aufgaben, Wartet, Automatisch erledigt), Login nur mit Google.
Den zuständigen AM liefert moovin oder – über das in der Mail erkannte Objekt – das CRM (Zoho, täglich nur lesend).
Für den Livetest lässt sich die moovin-Anbindung abschalten (Team → Objekte & Zuordnung): dann Platzhalter statt Bewerberdaten und Aufgaben statt moovin-Aktionen.

- Anforderungen: [`docs/SPEC.md`](docs/SPEC.md)
- API-Vertrag für moovin (IT): [`docs/moovin-api.openapi.yaml`](docs/moovin-api.openapi.yaml)
- Architektur & Betrieb: [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md)
- Regeln für Claude Code: [`CLAUDE.md`](CLAUDE.md)

## Schnellstart lokal
```bash
cp .env.example .env.local   # DATABASE_URL, MOOVIN_API_SECRET, INBOUND_WEBHOOK_TOKEN, GOOGLE_CLIENT_ID/SECRET setzen
npm install
npm run db:migrate -- --seed
npm run dev                  # http://localhost:3000 → „Mit Google anmelden“
npm run test:e2e             # End-to-End-Tests (lokale DB wird zurückgesetzt, Demo-Modus, keine Kosten)
```
Unter **Testmail** lassen sich Beispielmails einspielen. Ohne `ANTHROPIC_API_KEY` läuft ein Demo-Modus mit Stichwortregeln.

Testdaten (Personen, Objekte, AMs) sind fiktiv.
