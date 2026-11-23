"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface NavItem { id: string; label: string; href: string }

/** Presentation only: renders the nav the server sent. Bottom tab bar on phones, side rail from md up. */
export function WorkspaceShell(props: {
  businessName: string;
  assistantName: string;
  nav: NavItem[];
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-slate-50 p-4 md:flex">
        <p className="text-sm font-semibold" data-testid="business-name">{props.businessName}</p>
        <p className="mb-4 text-xs text-slate-500" data-testid="assistant-name">{props.assistantName}</p>
        <nav aria-label="Workspace" className="flex flex-col gap-1">
          {props.nav.map((n) => (
            <Link key={n.id} href={n.href} aria-current={active(n.href) ? "page" : undefined}
              className={`rounded px-3 py-2 text-sm ${active(n.href) ? "bg-indigo-600 text-white" : "text-slate-700 hover:bg-slate-200"}`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <form action={props.signOut} className="mt-auto">
          <button className="text-xs text-slate-500 underline" type="submit">Sign out</button>
        </form>
      </aside>
      <header className="border-b border-slate-200 px-4 py-3 md:hidden">
        <p className="text-sm font-semibold" data-testid="business-name-mobile">{props.businessName}</p>
        <p className="text-xs text-slate-500" data-testid="assistant-name-mobile">{props.assistantName}</p>
      </header>
      <main className="flex-1 p-4 pb-24 md:pb-4">{props.children}</main>
      <nav aria-label="Workspace" data-testid="bottom-nav"
        className="fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-slate-200 bg-white md:hidden">
        {props.nav.map((n) => (
          <Link key={n.id} href={n.href} aria-current={active(n.href) ? "page" : undefined}
            className={`min-h-12 flex-1 whitespace-nowrap px-3 py-3 text-center text-xs ${active(n.href) ? "font-semibold text-indigo-600" : "text-slate-600"}`}>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
