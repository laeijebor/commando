// Adapted from t3code (MIT, T3 Tools Inc.): apps/web/src/components/ui/popover.tsx.
// Trimmed to what the composer uses; the popup portals to <body>, so it carries
// the chat's scoped reset (`chat-floating`) instead of inheriting it.
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '../cn'

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger

export function PopoverPopup({
  children,
  className,
  side = 'top',
  align = 'start',
  sideOffset = 6,
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: PopoverPrimitive.Positioner.Props['side']
  align?: PopoverPrimitive.Positioner.Props['align']
  sideOffset?: PopoverPrimitive.Positioner.Props['sideOffset']
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner className="chat-floating z-[130] max-w-(--available-width)" side={side} align={align} sideOffset={sideOffset}>
        <PopoverPrimitive.Popup
          className={cn(
            'max-h-(--available-height) max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-input bg-popover p-1 text-sm text-secondary-label shadow-[0_8px_24px_rgb(0_0_0/45%)] outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}
