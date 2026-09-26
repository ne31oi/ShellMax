import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as SliderPrimitive from "@radix-ui/react-slider";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import clsx from "clsx";
import { Check, ChevronDown, X } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

// ---------------------------------------------------------------- buttons
type Variant = "primary" | "ghost" | "subtle" | "danger" | "outline";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-strong font-semibold",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  subtle: "bg-raised text-fg hover:bg-hover border border-line",
  outline: "border border-line text-fg hover:bg-hover",
  danger: "bg-bad/15 text-bad hover:bg-bad/25 border border-bad/30",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }
>(({ variant = "subtle", size = "md", className, ...props }, ref) => (
  <button
    ref={ref}
    className={clsx(
      "inline-flex items-center justify-center gap-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap",
      size === "sm" && "h-7 px-2.5 text-xs",
      size === "md" && "h-8 px-3",
      size === "lg" && "h-10 px-4 text-sm",
      variants[variant],
      className,
    )}
    {...props}
  />
));

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: "sm" | "md" }
>(({ label, active, size = "md", className, children, ...props }, ref) => (
  <Tip text={label}>
    <button
      ref={ref}
      aria-label={label}
      className={clsx(
        "inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40",
        size === "sm" ? "h-6 w-6" : "h-8 w-8",
        active ? "bg-accent/20 text-accent" : "text-muted hover:text-fg hover:bg-hover",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  </Tip>
));

// ---------------------------------------------------------------- tooltip
export function Tip({ text, children, side = "top" }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={350}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-72 rounded-md bg-raised border border-line px-2 py-1 text-xs text-fg shadow-xl"
        >
          {text}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TipProvider = TooltipPrimitive.Provider;

// ---------------------------------------------------------------- popover
export function Popover({
  trigger,
  children,
  align = "start",
  side = "top",
  open,
  onOpenChange,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          className={clsx("z-50 rounded-xl border border-line bg-panel p-3 shadow-2xl outline-none", className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
export const PopoverClose = PopoverPrimitive.Close;

// ---------------------------------------------------------------- slider / switch
export function Slider({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  className?: string;
}) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => onChange(v)}
      className={clsx("relative flex h-5 w-full touch-none select-none items-center", className)}
    >
      <SliderPrimitive.Track className="relative h-1 grow rounded-full bg-line">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full bg-fg shadow ring-2 ring-accent/40 outline-none focus-visible:ring-accent" />
    </SliderPrimitive.Root>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className={clsx(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <SwitchPrimitive.Thumb
        className={clsx("block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")}
      />
    </SwitchPrimitive.Root>
  );
}

// ---------------------------------------------------------------- dialog
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className={clsx(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line bg-panel shadow-2xl outline-none",
            wide ? "max-w-4xl" : "max-w-lg",
          )}
        >
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg" aria-label="Закрыть">
              <X size={16} />
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : ""}</DialogPrimitive.Description>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------- dropdown menu
export function Menu({ trigger, children, align = "end" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end" }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-40 min-w-52 rounded-xl border border-line bg-panel p-1 shadow-2xl"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  hint,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40",
        danger ? "text-bad" : "text-fg",
      )}
    >
      <span className="flex flex-1 items-center gap-2">{children}</span>
      {hint && <Kbd>{hint}</Kbd>}
    </DropdownMenu.Item>
  );
}

export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-faint">{children}</DropdownMenu.Label>
);

// ---------------------------------------------------------------- misc
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-raised px-1 py-px font-mono text-[10px] text-muted">{children}</kbd>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-80"
      style={{ width: size, height: size }}
    />
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</h3>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------- select
/** Dropdown for fields with a fixed set of choices; the workflow's value is marked. */
export function Select({ label, value, onChange, options, defaultValue }: {
  label?: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; defaultValue?: string;
}) {
  const all = options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options];
  const current = all.find((o) => o.value === value);
  // long lists: current value and the workflow's value pinned on top, the rest below
  const pinnedValues = all.length > 6 ? [...new Set([value, defaultValue].filter(Boolean) as string[])] : [];
  const pinned = pinnedValues.map((v) => all.find((o) => o.value === v)).filter(Boolean) as typeof all;
  const rest = all.filter((o) => !pinnedValues.includes(o.value));
  return (
    <div>
      {label && <p className="mb-1 text-xs text-muted">{label}</p>}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-line bg-raised px-2.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:border-accent/60 data-[state=open]:border-accent/60">
            <span className="truncate">{current?.label ?? value}</span>
            <ChevronDown size={13} className="shrink-0 text-faint" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={12}
            className="z-50 max-h-72 min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-xl border border-line bg-panel p-1 shadow-2xl">
            {[...pinned, ...rest].map((o, i) => (
              <div key={o.value}>
                {i === pinned.length && pinned.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}
                <DropdownMenu.Item onSelect={() => onChange(o.value)}
                  className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover">
                  <span className="w-4">{o.value === value && <Check size={13} className="text-accent" />}</span>
                  <span className="flex-1">{o.label}</span>
                  {o.value === defaultValue && <span className="text-[10px] text-faint">воркфлоу</span>}
                </DropdownMenu.Item>
              </div>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
