"use client";
import { useEffect, useState } from "react";
import { presenceAction } from "./actions";

/** Bearbeitungssperre (Anzeige): wer hat das Ticket gerade offen, ist inzwischen eine Antwort rausgegangen? */
export function Presence({ ticketId, lastOutId }: { ticketId: number; lastOutId: number | null }) {
  const [others, setOthers] = useState<{ email: string; name: string }[]>([]);
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await presenceAction(ticketId);
        if (!alive) return;
        setOthers(r.others);
        setNewer(r.lastOutId !== null && r.lastOutId !== lastOutId);
      } catch { /* Netzfehler ignorieren */ }
    };
    tick();
    const id = setInterval(tick, 20_000);
    const leave = () => { presenceAction(ticketId, true).catch(() => {}); };
    window.addEventListener("pagehide", leave);
    return () => { alive = false; clearInterval(id); window.removeEventListener("pagehide", leave); leave(); };
  }, [ticketId, lastOutId]);
  if (!others.length && !newer) return null;
  return (
    <div className="space-y-2" data-testid="presence">
      {others.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Gerade geöffnet von {others.map((o) => o.name).join(", ")} – bitte abstimmen, wer antwortet.
        </div>
      )}
      {newer && (
        <div className="rounded-lg border border-pink/30 bg-pink-50 px-3 py-2 text-sm text-pink">
          Inzwischen wurde eine Antwort gesendet. <button className="underline" onClick={() => location.reload()}>Neu laden</button>
        </div>
      )}
    </div>
  );
}
