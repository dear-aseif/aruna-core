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

/** Shared button: `primary` for the main action, `outline` for secondary ones. */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={`rounded-control ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest} />;
}
