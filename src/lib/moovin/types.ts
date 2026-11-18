// Typen gemäß docs/moovin-api.openapi.yaml
export type Appointment = {
  id: string;
  starts_at: string;
  ends_at?: string | null;
  kind?: "sammelbesichtigung" | "einzelbesichtigung" | "uebergabe";
  status: "eingeladen" | "bestaetigt" | "abgesagt" | "stattgefunden" | "no_show";
  meeting_point?: string | null;
};

export type Application = {
  id: string;
  object_id: string;
  object_title?: string;
  status: string;
  status_label: string;
  missing_documents: string[];
  next_step?: string;
  appointment?: Appointment | null;
  created_at?: string;
};

export type Applicant = {
  id: string;
  email: string;
  salutation?: string;
  first_name: string;
  last_name: string;
  preferred_language?: string;
};

export type ApplicantContext = { applicant: Applicant; applications: Application[] };

export type ObjectInfo = {
  id: string;
  title: string;
  address: string;
  district?: string;
  city?: string;
  rooms?: number;
  size_sqm?: number;
  rent_cold_eur?: number;
  rent_warm_eur?: number;
  available_from?: string;
  pets?: string;
  parking?: string;
  wbs_required?: boolean;
  viewing_info?: string;
  application_info?: string;
  listing_url?: string;
  account_manager?: { name: string; email: string };
};
