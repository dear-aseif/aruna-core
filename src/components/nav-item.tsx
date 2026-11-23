import Link from "next/link";

/** One navigation link. `rail` is the side-rail style (md and up); `tab` is the bottom-bar style on phones. */
export function NavItem(props: { href: string; label: string; active: boolean; variant: "rail" | "tab" }) {
  const cls =
    props.variant === "rail"
      ? `rounded-control px-cozy py-snug text-body ${props.active ? "bg-primary text-primary-ink" : "text-ink-soft hover:bg-hover"}`
      : `min-h-tap flex-1 whitespace-nowrap px-cozy py-cozy text-center text-caption ${props.active ? "font-semibold text-primary" : "text-ink-muted"}`;
  return (
    <Link href={props.href} aria-current={props.active ? "page" : undefined} className={cls}>
      {props.label}
    </Link>
  );
}
