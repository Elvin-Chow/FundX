import type { ButtonHTMLAttributes } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type RefreshIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  loading?: boolean;
  iconSize?: number;
};

export function RefreshIconButton({
  className,
  disabled,
  iconSize = 18,
  label,
  loading = false,
  title,
  type = "button",
  ...props
}: RefreshIconButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-transparent text-zinc-500 transition hover:border-zinc-200 hover:bg-zinc-50 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-white dark:focus-visible:ring-emerald-300 dark:focus-visible:ring-offset-zinc-950",
        className,
      )}
      {...props}
    >
      <RefreshCw size={iconSize} strokeWidth={1.9} className={cn("transition", loading && "animate-spin")} />
    </button>
  );
}
