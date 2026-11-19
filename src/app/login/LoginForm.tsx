"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="next" value={next} />
      <div>
        <label className="label" htmlFor="email">E-Mail</label>
        <input className="input h-11" id="email" name="email" type="email" required placeholder="vorname.nachname@moovin.de" autoComplete="username" autoFocus />
      </div>
      <div>
        <label className="label" htmlFor="password">Passwort</label>
        <input className="input h-11" id="password" name="password" type="password" required autoComplete="current-password" />
      </div>
      {error && <p className="rounded-lg bg-pink-50 px-3 py-2 text-sm text-pink">{error}</p>}
      <button className="btn-pink h-11 w-full text-[15px]" disabled={pending}>{pending ? "Anmelden …" : "Anmelden"}</button>
      <p className="pt-2 text-center text-xs text-muted">Zugang nur für das moovin-Team. Anmeldung mit dem moovin-Konto (SSO) folgt.</p>
    </form>
  );
}
