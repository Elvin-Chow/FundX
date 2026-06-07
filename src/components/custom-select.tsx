"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CustomSelectOption<TValue extends string> = {
  value: TValue;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

export type CustomSelectProps<TValue extends string> = {
  value: TValue;
  options: Array<CustomSelectOption<TValue>>;
  onChange: (value: TValue) => void;
  size?: "compact" | "regular";
  placeholder?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  menuClassName?: string;
};

export function CustomSelect<TValue extends string>({
  value,
  options,
  onChange,
  size = "compact",
  placeholder,
  ariaLabel,
  disabled = false,
  className,
  buttonClassName,
  menuClassName,
}: CustomSelectProps<TValue>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const selectId = useId();
  const listboxId = `${selectId}-listbox`;
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIndex = useMemo(() => options.findIndex((option) => option.value === value), [options, value]);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const enabledIndexes = useMemo(
    () => options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0),
    [options],
  );
  const activeOptionId = isOpen && activeIndex >= 0 ? optionId(listboxId, activeIndex) : undefined;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (activeIndex >= 0 && options[activeIndex] && !options[activeIndex].disabled) return;
    setActiveIndex(defaultActiveIndex(selectedIndex, enabledIndexes));
  }, [activeIndex, enabledIndexes, isOpen, options, selectedIndex]);

  function openMenu() {
    if (disabled || !enabledIndexes.length) return;
    setActiveIndex(defaultActiveIndex(selectedIndex, enabledIndexes));
    setIsOpen(true);
  }

  function closeMenu() {
    setIsOpen(false);
  }

  function chooseOption(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setIsOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function moveActive(delta: 1 | -1) {
    if (!enabledIndexes.length) return;
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const fallbackPosition = delta > 0 ? 0 : enabledIndexes.length - 1;
    const nextPosition = currentPosition === -1
      ? fallbackPosition
      : (currentPosition + delta + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      closeMenu();
      return;
    }

    if (event.key === "Tab") {
      closeMenu();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) openMenu();
      else moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) openMenu();
      else moveActive(-1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      if (activeIndex >= 0) chooseOption(activeIndex);
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn("relative text-sm", className)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        closeMenu();
      }}
    >
      <button
        ref={buttonRef}
        id={selectId}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        onClick={() => {
          if (isOpen) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          "group flex w-full items-center justify-between gap-3 border border-zinc-200 bg-white px-3 text-left text-sm font-medium text-zinc-700 outline-none transition",
          size === "regular" ? "h-11 rounded-lg" : "h-10 rounded",
          "hover:border-zinc-300 hover:bg-zinc-50 focus-visible:border-emerald-500 focus-visible:ring-4 focus-visible:ring-emerald-500/10",
          "disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-white dark:hover:bg-white/10 dark:disabled:bg-white/[0.02] dark:disabled:text-zinc-500",
          isOpen && "border-emerald-500 ring-4 ring-emerald-500/10",
          buttonClassName,
        )}
      >
        <span className={cn("min-w-0 truncate", selectedOption ? "text-zinc-900" : "text-zinc-400")}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown
          size={18}
          className={cn("shrink-0 text-zinc-500 transition group-disabled:text-zinc-300", isOpen && "rotate-180 text-zinc-950")}
          aria-hidden="true"
        />
      </button>

      {isOpen ? (
        <div
          id={listboxId}
          role="listbox"
          aria-labelledby={selectId}
          className={cn(
            "absolute left-0 right-0 z-40 mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-950/10 dark:border-white/10 dark:bg-zinc-950 dark:shadow-black/30",
            menuClassName,
          )}
        >
          <div className="thin-scrollbar max-h-72 overflow-y-auto">
            {options.map((option, index) => {
              const selected = option.value === value;
              const active = index === activeIndex;

              return (
                <button
                  key={option.value}
                  id={optionId(listboxId, index)}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled}
                  disabled={option.disabled}
                  onMouseEnter={() => {
                    if (!option.disabled) setActiveIndex(index);
                  }}
                  onClick={() => chooseOption(index)}
                  className={cn(
                    "flex min-h-10 w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                    "disabled:cursor-not-allowed disabled:text-zinc-300",
                    selected ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300" : "text-zinc-700 dark:text-zinc-200",
                    active && !selected && "bg-zinc-50 text-zinc-950 dark:bg-white/10 dark:text-white",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs font-normal text-zinc-500 dark:text-zinc-400">{option.description}</span>
                    ) : null}
                  </span>
                  {selected ? <Check size={16} className="shrink-0 text-emerald-600" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function defaultActiveIndex(selectedIndex: number, enabledIndexes: number[]) {
  if (!enabledIndexes.length) return -1;
  return selectedIndex >= 0 && enabledIndexes.includes(selectedIndex) ? selectedIndex : enabledIndexes[0];
}

function optionId(listboxId: string, index: number) {
  return `${listboxId}-option-${index}`;
}
