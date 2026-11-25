import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const variants = {
  default: "border-transparent bg-primary text-surface enabled:hover:bg-primary/90",
  outline: "border-divider bg-elevated text-foreground enabled:hover:bg-surface",
  ghost: "border-transparent bg-transparent text-foreground enabled:hover:bg-elevated",
};

const sizes = {
  default: "h-9 px-3",
  sm: "h-8 px-2.5",
  icon: "size-9",
};

type ButtonProps = ComponentProps<"button"> & {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};

export function Button({
  className,
  size = "default",
  type = "button",
  variant = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg border text-sm font-medium",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
