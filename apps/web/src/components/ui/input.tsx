import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-md border border-border bg-card px-3 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
