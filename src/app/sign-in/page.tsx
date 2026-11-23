import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { Button } from "@/components/button";
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
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-gutter-lg">
      <h1 className="text-display font-semibold">Sign in</h1>
      <form action={login} className="mt-gutter flex flex-col gap-cozy">
        <label className="text-body">Email
          <input name="email" type="email" required autoComplete="username" className="mt-tight w-full rounded-control border border-border-strong p-snug" />
        </label>
        <label className="text-body">Password
          <input name="password" type="password" required autoComplete="current-password" className="mt-tight w-full rounded-control border border-border-strong p-snug" />
        </label>
        {error ? <p role="alert" className="text-body text-danger">Sign-in failed. Check your email and password.</p> : null}
        <Button type="submit" className="p-cozy">Sign in</Button>
      </form>
    </main>
  );
}
