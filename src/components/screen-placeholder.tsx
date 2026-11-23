"use client";
import { useT } from "./i18n-provider";
import type { StringKey } from "@/i18n/strings";

/** Placeholder body for screens built in later tasks. Title is the localized nav label; text comes from the strings table. */
export function ScreenPlaceholder(props: { navId: string; navLabel?: string; bodyKey: StringKey }) {
  const { t, nav } = useT();
  return (
    <section>
      <h1 className="text-title font-semibold">{nav({ id: props.navId, label: props.navLabel ?? props.navId })}</h1>
      <p className="mt-snug text-ink-muted">{t(props.bodyKey)}</p>
    </section>
  );
}
