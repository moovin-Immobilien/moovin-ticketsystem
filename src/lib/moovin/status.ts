import type { ApplicationStatus } from "./types";

// Texte zum Bewerbungsstatus liegen im Ticketsystem, nicht in der API (weniger Aufwand für moovin, eine Quelle für Formulierungen).
export const STATUS_TEXT: Record<ApplicationStatus, { label: string; next: string }> = {
  eingegangen: { label: "Ihre Bewerbung ist eingegangen.", next: "Wir prüfen Ihre Unterlagen auf Vollständigkeit." },
  unvollstaendig: { label: "Ihre Bewerbung ist eingegangen, es fehlen noch Unterlagen.", next: "Bitte reichen Sie die fehlenden Unterlagen nach." },
  in_pruefung: { label: "Ihre Unterlagen werden geprüft.", next: "Wir melden uns, sobald die Prüfung abgeschlossen ist." },
  eingeladen: { label: "Sie sind zur Besichtigung eingeladen.", next: "Bitte nehmen Sie den Besichtigungstermin wahr oder sagen Sie rechtzeitig ab." },
  besichtigt: { label: "Sie haben die Wohnung besichtigt.", next: "Bitte bestätigen Sie Ihr Interesse, falls noch nicht geschehen. Danach stellen wir die Bewerbungen dem Eigentümer vor." },
  beim_eigentuemer: { label: "Ihre Bewerbung liegt dem Eigentümer zur Entscheidung vor.", next: "Wir melden uns, sobald eine Entscheidung vorliegt." },
  zusage: { label: "Sie haben eine Zusage erhalten.", next: "Ihr Ansprechpartner meldet sich wegen des Mietvertrags." },
  absage: { label: "Die Wohnung wurde leider anderweitig vergeben.", next: "Gerne können Sie sich auf weitere Angebote bewerben." },
  zurueckgezogen: { label: "Sie haben Ihre Bewerbung zurückgezogen.", next: "Es sind keine weiteren Schritte nötig." },
};

export const APPLICATION_STATUS = Object.keys(STATUS_TEXT) as ApplicationStatus[];
