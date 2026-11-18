"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label className="label" htmlFor="email">moovin-Mailadresse</label>
        <input className="input" id="email" name="email" type="email" required placeholder="vorname.nachname@moovin.de" autoComplete="username" />
      </div>
      <div>
        <label className="label" htmlFor="password">Prototyp-Passwort</label>
        <input className="input" id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      {error && <p className="text-sm text-pink">{error}</p>}
      <button className="btn-primary w-full" disabled={pending}>{pending ? "Anmelden …" : "Anmelden"}</button>
      <p className="text-xs text-muted">Prototyp-Login. Im Livebetrieb: Anmeldung mit dem moovin-Konto (SSO).</p>
    </form>
  );
}
