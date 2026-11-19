import type { ActionType, Intent } from "../intents";
import type { ApplicantContext, Listing } from "../moovin/types";

export type ProposedAction = {
  type: ActionType;
  application_id: string;
  appointment_id: string;
  interest: "interessiert" | "zurueckgezogen" | "";
  text: string;
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
  tools: {
    getApplicationStatus: () => Promise<ApplicantContext | null>;
    getObjectInfo: (listingId: string) => Promise<Listing | null>;
    searchKnowledge: (query: string) => Promise<{ title: string; body: string; scope: string }[]>;
  };
};

export type AgentOutput = { result: AgentResult; model: string; usage: Record<string, number> | null; toolCalls: string[] };
