import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "outline";
export type ButtonSize = "md" | "sm";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-ink",
  outline: "border border-border-strong bg-surface text-ink-soft hover:bg-hover",
};
const SIZE: Record<ButtonSize, string> = {
  md: "p-cozy text-body",
  sm: "px-snug py-tight text-caption",
};

/** The one place button styling is composed; `Button` and `ButtonLink` both use it. */
export function buttonClass(variant: ButtonVariant = "primary", size: ButtonSize = "md", extra = ""): string {
  return `rounded-control disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${extra}`.trim();
}

/** Shared button: `primary` for the main action, `outline` for secondary ones. */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
