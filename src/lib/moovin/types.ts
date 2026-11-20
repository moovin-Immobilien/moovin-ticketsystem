// Typen gemäß docs/moovin-api.openapi.yaml (Datensparsam: nur was für die Antwort auf eine Mail nötig ist)

export type ApplicationStatus =
  | "eingegangen" | "unvollstaendig" | "in_pruefung" | "eingeladen" | "besichtigt"
  | "beim_eigentuemer" | "zusage" | "absage" | "zurueckgezogen";

export type Appointment = {
  id: string; // interne Kennung, wird nie an Bewerber herausgegeben
  starts_at: string; // ISO 8601 mit Zeitzone
  ends_at?: string | null;
  status: "eingeladen" | "bestaetigt" | "abgesagt" | "stattgefunden" | "no_show";
  meeting_point?: string | null;
};

export type Application = {
  id: string;
  listing_id: string; // Inserats-Kennung, z. B. MV-ABC123
  object_title: string; // wie im Inserat, z. B. „2-Zimmer, Lindenallee 12, Hamburg“
  status: ApplicationStatus;
  missing_documents: string[]; // nur Dokumentarten, keine Inhalte
  account_manager_email?: string | null;
  appointment?: Appointment | null; // nächster bzw. letzter Termin dieser Bewerbung
  // vom Ticketsystem ergänzt (nicht Teil der API):
  status_label?: string;
  next_step?: string;
};

export type Applicant = {
  id: string;
  salutation?: string | null; // „Frau“, „Herr“ oder leer – nur für die Anrede
  last_name: string;
  language?: string | null; // de, en …
};

export type ApplicantContext = { applicant: Applicant; applications: Application[] };

/** Öffentliche Inseratsdaten – nichts, was nicht ohnehin im Inserat steht. */
export type Listing = {
  id: string;
  title: string;
  address: string;
  rooms?: number | null;
  size_sqm?: number | null;
  rent_cold_eur?: number | null;
  rent_warm_eur?: number | null;
  available_from?: string | null;
  pets?: string | null;
  parking?: string | null;
  wbs_required?: boolean | null;
  viewing_info?: string | null;
  listing_url?: string | null;
};
