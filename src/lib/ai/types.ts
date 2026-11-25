import type { ActionType, Intent } from "../intents";
import type { ApplicantContext, Listing } from "../moovin/types";

export type ProposedAction = {
  type: ActionType;
  application_id: string;
  appointment_id: string;
  interest: "interessiert" | "zurueckgezogen" | "";
  text: string;
  /** moovin-Anbindung aus: kein Aufruf an moovin, der AM erledigt es (Aufgabe) */
  manual?: boolean;
};

export type AgentResult = {
  intent: Intent;
  language: string;
  confidence: number;
  summary: string;
  reply_text: string;
  actions: ProposedAction[];
  needs_human: boolean;
  needs_human_reason: string;
  /** Antwort enthält eine Rückfrage, ohne deren Beantwortung das Anliegen nicht erledigt ist → Ticket „wartet auf Bewerber“ */
  awaits_reply?: boolean;
  /** Ticket-Intelligenz: Hinweise aus dem Mailtext (feste Werte); der Server bestätigt sie und setzt die Stufe */
  signals?: { type: string; evidence: string; deadline: string }[];
};

export type AgentInput = {
  ticketId: number;
  senderEmail: string;
  senderName: string;
  subject: string;
  newMessage: string;
  attachments: { filename: string; contentType: string }[];
  history: { direction: "in" | "out"; text: string; at: string }[];
  senderVerified: boolean;
  context: ApplicantContext | null; // nur für Demo-Modus/Validierung; Claude bekommt Daten ausschließlich über Werkzeuge
  /** moovin-Anbindung aus (Livetest): keine Bewerberdaten, keine moovin-Werkzeuge */
  moovinOff?: boolean;
  /** Objekt laut CRM, aus der Mail erkannt (nur Titel/Adresse – keine internen Daten) */
  crmObject?: { object_id: string; title: string | null } | null;
  tools: {
    getApplicationStatus: () => Promise<ApplicantContext | null>;
    getObjectInfo: (listingId: string) => Promise<Listing | null>;
    searchKnowledge: (query: string) => Promise<{ title: string; body: string; scope: string }[]>;
  };
};

export type AgentOutput = { result: AgentResult; model: string; usage: Record<string, number> | null; toolCalls: string[] };
