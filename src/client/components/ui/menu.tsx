import { Check } from "lucide-react";
import { DropdownMenu as M } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;
export const MenuGroup = M.Group;

export function MenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={6}
        className={cn("z-50 min-w-44 max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-pop text-[13px]", className)}
        {...props}
      />
    </M.Portal>
  );
}

export function MenuItem({ className, destructive, ...props }: React.ComponentProps<typeof M.Item> & { destructive?: boolean }) {
  return (
    <M.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-subtle data-[disabled]:opacity-50 data-[disabled]:pointer-events-none [&_svg]:size-4 [&_svg]:text-ink-3",
        destructive && "text-danger [&_svg]:text-danger",
        className,
      )}
      {...props}
    />
  );
}

export function MenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn("flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 relative outline-none data-[highlighted]:bg-subtle", className)} {...props}>
      <M.ItemIndicator className="absolute left-2">
        <Check className="size-3.5" />
      </M.ItemIndicator>
      {children}
    </M.CheckboxItem>
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-4", className)} {...props} />;
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />;
}
