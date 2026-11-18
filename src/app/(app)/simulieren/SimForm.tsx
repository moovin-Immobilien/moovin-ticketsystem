"use client";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { simulateAction } from "./actions";

type Sample = { key: string; label: string; from: string; name: string; subject: string; body: string; attach: boolean };

function Submit() {
  const { pending } = useFormStatus();
  return <button className="btn-pink" disabled={pending}>{pending ? "Mail wird verarbeitet …" : "Mail einspielen"}</button>;
}

export function SimForm({ samples }: { samples: readonly Sample[] }) {
  const [s, setS] = useState<Sample>(samples[0]);
  return (
    <form action={simulateAction} className="space-y-4" key={s.key}>
      <div>
        <label className="label">Vorlage</label>
        <select className="input" value={s.key} onChange={(e) => setS(samples.find((x) => x.key === e.target.value) ?? samples[0])}>
          {samples.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
        </select>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="label">Absender-Mail</label><input className="input" name="from" defaultValue={s.from} required type="email" /></div>
        <div><label className="label">Name</label><input className="input" name="name" defaultValue={s.name} /></div>
      </div>
      <div><label className="label">Betreff</label><input className="input" name="subject" defaultValue={s.subject} /></div>
      <div><label className="label">Text</label><textarea className="input min-h-44" name="body" defaultValue={s.body} required /></div>
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="verified" defaultChecked className="accent-navy" /> Absender verifiziert (DKIM/DMARC pass)</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="attach" defaultChecked={s.attach} className="accent-navy" /> 2 PDF-Anhänge mitschicken</label>
      </div>
      <Submit />
    </form>
  );
}
