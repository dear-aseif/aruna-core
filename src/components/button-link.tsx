import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./button";

/** A link that looks like a `Button` (same variants and sizes). For navigation actions. */
export function ButtonLink(props: { href: string; children: ReactNode; variant?: ButtonVariant; size?: ButtonSize; className?: string }) {
  return (
    <Link href={props.href} className={buttonClass(props.variant ?? "outline", props.size ?? "md", `inline-block text-center ${props.className ?? ""}`)}>
      {props.children}
    </Link>
  );
}
