import type { ReactNode } from "react";
/** A titled block of the settings screen. Layout only; the title arrives already translated. */
export function SettingsSection(props: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={props.testId} className="flex flex-col gap-snug rounded-control border border-border bg-surface p-cozy">
      <h2 className="text-body font-semibold text-ink">{props.title}</h2>
      {props.children}
    </section>
  );
}
