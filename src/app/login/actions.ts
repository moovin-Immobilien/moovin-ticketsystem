"use server";
import { redirect } from "next/navigation";
import { login, logout } from "@/lib/auth";

export async function loginAction(_: string | null, form: FormData): Promise<string | null> {
  const err = await login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (err) return err;
  const next = String(form.get("next") ?? "/mein");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/mein");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
