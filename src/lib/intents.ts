export const INTENTS = [
  "bewerbungsstatus", "unterlagen_nachreichen", "termin_bestaetigen", "termin_absage", "termin_verschieben", "besichtigung_frage",
  "objekt_frage", "interesse_bestaetigen", "rueckzug", "wohnungssuche_allgemein", "konto_datenschutz", "technik_login",
  "beschwerde", "nicht_zustaendig", "intern_system", "sonstiges", "spam",
] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABEL: Record<Intent, string> = {
  bewerbungsstatus: "Stand der Bewerbung",
  unterlagen_nachreichen: "Unterlagen nachreichen",
  termin_bestaetigen: "Termin bestätigen",
  termin_absage: "Termin absagen",
  termin_verschieben: "Termin verschieben",
  besichtigung_frage: "Frage zur Besichtigung",
  objekt_frage: "Frage zum Objekt",
  interesse_bestaetigen: "Interesse bestätigen",
  rueckzug: "Bewerbung zurückziehen",
  wohnungssuche_allgemein: "Allgemeine Wohnungssuche",
  konto_datenschutz: "Konto / Daten löschen",
  technik_login: "Technik / Login / Profil",
  beschwerde: "Beschwerde",
  nicht_zustaendig: "Nicht zuständig",
  intern_system: "System-/interne Mail",
  sonstiges: "Sonstiges",
  spam: "Spam",
};

export const ACTION_TYPES = ["dokumente_ablegen", "termin_bestaetigen", "termin_absagen", "termin_verschieben_wunsch", "interesse_setzen", "notiz"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_LABEL: Record<ActionType, string> = {
  dokumente_ablegen: "Anhänge an Bewerbung ablegen",
  termin_bestaetigen: "Teilnahme am Termin bestätigen",
  termin_absagen: "Termin absagen (Slot freigeben)",
  termin_verschieben_wunsch: "Verschiebe-Wunsch an AM übermitteln",
  interesse_setzen: "Interesse/Rückzug in moovin setzen",
  notiz: "Notiz am Bewerber anlegen",
};
