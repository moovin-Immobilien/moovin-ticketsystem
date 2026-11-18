import { requireAgent } from "@/lib/auth";
import { SAMPLES } from "@/lib/samples";
import { SimForm } from "./SimForm";

export default async function SimPage() {
  await requireAgent();
  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-5">
      <section className="card p-6">
        <h1 className="text-lg font-semibold text-navy mb-1">Testmail einspielen</h1>
        <p className="text-sm text-muted mb-5">Simuliert eine eingehende Mail an mieter@moovin.de – genau wie der echte Webhook. Die Absender stammen aus den fiktiven Testdaten.</p>
        <SimForm samples={SAMPLES} />
      </section>
      <aside className="card p-5 text-sm space-y-3 h-fit">
        <h2 className="font-semibold text-navy">Testbewerber</h2>
        <ul className="space-y-2 text-muted">
          <li><b className="text-ink">Anna Schmidt</b> – Hamburg, Unterlagen fehlen, Termin in 2 Tagen</li>
          <li><b className="text-ink">Mehmet Yilmaz</b> – Berlin, hat besichtigt</li>
          <li><b className="text-ink">Julia Becker</b> – Berlin, Termin morgen</li>
          <li><b className="text-ink">Tom Richter</b> – Potsdam, beim Eigentümer</li>
          <li><b className="text-ink">Sarah Klein</b> – Hamburg, Absage erhalten</li>
          <li><b className="text-ink">Lucas Martin</b> – Berlin, englisch, Termin in 3 Tagen</li>
        </ul>
        <p className="text-xs text-muted">Echter Eingang später per Webhook: <code>POST /api/inbound/email?token=…</code> (Postmark-Format).</p>
      </aside>
    </div>
  );
}
