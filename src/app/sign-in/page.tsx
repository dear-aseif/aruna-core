import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/server/auth/authjs";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  async function login(form: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        redirectTo: "/board",
      });
    } catch (e) {
      if (e instanceof AuthError) redirect("/sign-in?error=1");
      throw e;
    }
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <form action={login} className="mt-4 flex flex-col gap-3">
        <label className="text-sm">Email
          <input name="email" type="email" required autoComplete="username" className="mt-1 w-full rounded border border-slate-300 p-2" />
        </label>
        <label className="text-sm">Password
          <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded border border-slate-300 p-2" />
        </label>
        {error ? <p role="alert" className="text-sm text-red-600">Sign-in failed. Check your email and password.</p> : null}
        <button type="submit" className="rounded bg-indigo-600 p-3 text-white">Sign in</button>
      </form>
    </main>
  );
}
