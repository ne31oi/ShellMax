import * as ContextMenu from "@radix-ui/react-context-menu";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function TlCtxItem({
  icon: Icon,
  children,
  onSelect,
  danger,
  disabled,
}: {
  icon: LucideIcon;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <ContextMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={clsx(
        "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40",
        danger ? "text-bad" : "text-fg",
      )}
    >
      <Icon size={13} />
      {children}
    </ContextMenu.Item>
  );
}
