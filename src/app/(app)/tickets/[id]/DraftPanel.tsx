"use client";
import { useState, useTransition } from "react";
import { sendAction, regenerateAction, closeAction } from "./actions";

type Action = { id: number; label: string; status: string; blocked_reason: string | null; type: string };

export function DraftPanel(props: { ticketId: number; draftId: number | null; draftText: string; actions: Action[]; recipient: string; editable: boolean; awaitsReply?: boolean; lastOutId?: number | null }) {
  const [text, setText] = useState(props.draftText);
  const [selected, setSelected] = useState<number[]>(props.actions.filter((a) => a.status === "vorgeschlagen").map((a) => a.id));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [awaitReply, setAwaitReply] = useState(!!props.awaitsReply);
  const [pending, start] = useTransition();
  const send = (force: boolean) => start(async () => {
    const r = await sendAction(props.ticketId, props.draftId!, text, selected, { awaitReply, knownLastMessageId: props.lastOutId ?? null, force });
    if (r.conflict) {
      if (confirm(r.message)) send(true); else setMsg({ ok: false, text: "Nicht gesendet – bitte Verlauf prüfen (Seite neu laden)." });
      return;
    }
    setMsg({ ok: r.ok, text: r.message + (r.ok && r.failed?.length ? ` Fehler: ${r.failed.map((f) => f.error).join("; ")}` : "") });
  });
  const hasPlaceholder = /\[AM:/.test(text);

  if (!props.editable || !props.draftId) {
    return (
      <div className="flex gap-2">
        <button className="btn-ghost" disabled={pending} onClick={() => start(async () => { await regenerateAction(props.ticketId); })}>{pending ? "KI arbeitet …" : "Neuen KI-Entwurf erstellen"}</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-1">
          <label className="label">Antwort an {props.recipient}</label>
          {hasPlaceholder && <span className="text-xs text-pink">Platzhalter [AM: …] ersetzen, bevor gesendet wird</span>}
        </div>
        <textarea className="input font-[inherit] leading-relaxed min-h-72" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      {props.actions.length > 0 && (
        <div>
          <div className="label">Aktionen in moovin</div>
          <ul className="space-y-2">
            {props.actions.map((a) => (
              <li key={a.id} className={`flex items-start gap-3 rounded-lg border px-3 py-2 text-sm ${a.status === "blockiert" ? "border-amber-200 bg-amber-50" : "border-line bg-white"}`}>
                <input type="checkbox" className="mt-0.5 accent-navy" disabled={a.status !== "vorgeschlagen"} checked={selected.includes(a.id)}
                  onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.id] : s.filter((x) => x !== a.id)))} />
                <div>
                  <div className={a.status === "blockiert" ? "text-amber-800" : "text-ink"}>{a.label}</div>
                  {a.blocked_reason && <div className="text-xs text-amber-700">{a.blocked_reason}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="awaitReply" className="accent-navy" checked={awaitReply} onChange={(e) => setAwaitReply(e.target.checked)} />
        Rückfrage an den Bewerber – Ticket wartet auf seine Antwort
      </label>

      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-pink-50 text-pink"}`}>{msg.text}</div>}

      <div className="flex flex-wrap gap-2">
        <button className="btn-pink" disabled={pending || hasPlaceholder || !text.trim()}
          onClick={() => send(false)}>
          {pending ? "Bitte warten …" : "Freigeben & senden"}
        </button>
        <button className="btn-ghost" disabled={pending} onClick={() => start(async () => { await regenerateAction(props.ticketId); setMsg(null); })}>Neu generieren</button>
        <button className="btn-ghost" disabled={pending} onClick={() => { if (confirm("Ticket ohne Antwort schließen?")) start(async () => { await closeAction(props.ticketId); }); }}>Ohne Antwort schließen</button>
        <button className="btn-ghost" disabled={pending || text === props.draftText} onClick={() => setText(props.draftText)}>Entwurf zurücksetzen</button>
      </div>
    </div>
  );
}
