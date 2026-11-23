"use client";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import type { Language } from "@/i18n/strings";
import { BottomNav } from "./bottom-nav";
import { BusinessHeader } from "./business-header";
import { Button } from "./button";
import { I18nProvider, useT } from "./i18n-provider";
import { LanguageToggle } from "./language-toggle";
import { NavItem } from "./nav-item";

interface NavEntry { id: string; label: string; href: string }

/** Presentation only: renders the nav the server sent. Bottom tab bar on phones, side rail from md up. */
export function WorkspaceShell(props: {
  businessName: string;
  assistantName: string;
  language: Language;
  nav: NavEntry[];
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <I18nProvider language={props.language}>
      <ShellFrame {...props} />
    </I18nProvider>
  );
}

function ShellFrame(props: Parameters<typeof WorkspaceShell>[0]) {
  const pathname = usePathname();
  const { lang, t, nav } = useT();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const items = props.nav.map((n) => ({
    id: n.id,
    href: n.href,
    label: nav(n),
    active: pathname === n.href || pathname.startsWith(`${n.href}/`),
  }));
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <aside className="hidden w-rail shrink-0 flex-col border-r border-border bg-surface-muted p-gutter md:flex">
        <BusinessHeader variant="rail" businessName={props.businessName} assistantName={props.assistantName} />
        <nav aria-label={t("shell.navLabel")} className="flex flex-col gap-tight">
          {items.map((n) => (
            <NavItem key={n.id} href={n.href} label={n.label} active={n.active} variant="rail" />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-cozy">
          <LanguageToggle />
          <form action={props.signOut}>
            <Button type="submit" variant="outline" size="sm">{t("shell.signOut")}</Button>
          </form>
        </div>
      </aside>
      <BusinessHeader variant="bar" businessName={props.businessName} assistantName={props.assistantName} action={<LanguageToggle />} />
      <main className="flex-1 p-gutter pb-clear-nav md:pb-gutter">{props.children}</main>
      <BottomNav label={t("shell.navLabel")} items={items} />
    </div>
  );
}
