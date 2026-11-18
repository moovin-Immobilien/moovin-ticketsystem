import { LoginForm } from "./LoginForm";

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/tickets";
  return (
    <main className="flex-1 grid place-items-center p-6">
      <div className="card w-full max-w-sm p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/moovin-logo.svg" alt="moovin" className="h-9 mb-6" />
        <h1 className="text-lg font-semibold text-navy mb-1">Ticketsystem</h1>
        <p className="text-sm text-muted mb-6">Anmeldung für das Vermietungsteam</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
