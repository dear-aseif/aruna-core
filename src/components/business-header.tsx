import type { ReactNode } from "react";

/** Business name and assistant name. `bar` is the phone header (with an optional action slot); `rail` sits atop the side rail. */
export function BusinessHeader(props: { businessName: string; assistantName: string; variant: "rail" | "bar"; action?: ReactNode }) {
  const suffix = props.variant === "bar" ? "-mobile" : "";
  const text = (
    <div>
      <p className="text-body font-semibold" data-testid={`business-name${suffix}`}>{props.businessName}</p>
      <p className="text-caption text-ink-muted" data-testid={`assistant-name${suffix}`}>{props.assistantName}</p>
    </div>
  );
  if (props.variant === "rail") return <div className="mb-gutter">{text}</div>;
  return (
    <header className="flex items-center justify-between gap-snug border-b border-border px-gutter py-cozy md:hidden">
      {text}
      {props.action}
    </header>
  );
}
