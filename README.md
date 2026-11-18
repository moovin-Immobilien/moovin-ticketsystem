# moovin Ticketsystem (Prototyp)

KI-gestütztes Ticketsystem für Mails von Mietinteressenten an mieter@moovin.de – ersetzt Zoho Desk.
Claude beantwortet Anliegen auf Basis einer Wissensdatenbank und Live-Daten aus moovin (über eine schmale,
signierte API) und löst einfache Aktionen aus (Termin absagen, Unterlagen ablegen, Interesse setzen).

- Anforderungen: [`docs/SPEC.md`](docs/SPEC.md)
- API-Vertrag für moovin (IT): [`docs/moovin-api.openapi.yaml`](docs/moovin-api.openapi.yaml)
- Architektur & Betrieb: [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md)
- Regeln für Claude Code: [`CLAUDE.md`](CLAUDE.md)

## Schnellstart lokal
```bash
cp .env.example .env.local   # DATABASE_URL, MOOVIN_API_SECRET, INBOUND_WEBHOOK_TOKEN, PROTOTYPE_PASSWORD setzen
npm install
npm run db:migrate -- --seed
npm run dev                  # http://localhost:3000 → Login mit z. B. mellin@moovin.de + Prototyp-Passwort
```
Unter **Testmail** lassen sich Beispielmails einspielen. Ohne `ANTHROPIC_API_KEY` läuft ein Demo-Modus mit Stichwortregeln.

Testdaten (Personen, Objekte, AMs) sind fiktiv.
