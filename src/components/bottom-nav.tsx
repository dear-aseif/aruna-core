"use client";
import { NavItem } from "./nav-item";

/** Phone tab bar: fixed to the bottom, hidden from md up. */
export function BottomNav(props: { label: string; items: { id: string; label: string; href: string; active: boolean }[] }) {
  return (
    <nav aria-label={props.label} data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-10 flex overflow-x-auto border-t border-border bg-surface md:hidden">
      {props.items.map((n) => (
        <NavItem key={n.id} href={n.href} label={n.label} active={n.active} variant="tab" />
      ))}
    </nav>
  );
}
