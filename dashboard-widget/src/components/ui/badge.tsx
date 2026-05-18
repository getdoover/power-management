import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none select-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/10 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        success:
          "border-transparent bg-green-500/10 text-green-700 dark:text-green-400",
        warning:
          "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
        destructive:
          "border-transparent bg-destructive/10 text-destructive",
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeProps };
