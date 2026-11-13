// A dropdown menu styled like the popover; the popup portals to <body>, so it
// carries the chat's scoped reset (`chat-floating`) instead of inheriting it.
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { Check } from 'lucide-react'
import { cn } from '../cn'

export const Menu = MenuPrimitive.Root
export const MenuTrigger = MenuPrimitive.Trigger

export function MenuPopup({
  children,
  className,
  side = 'bottom',
  align = 'end',
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props & {
  side?: MenuPrimitive.Positioner.Props['side']
  align?: MenuPrimitive.Positioner.Props['align']
  sideOffset?: MenuPrimitive.Positioner.Props['sideOffset']
}) {
  return (
    <MenuPrimitive.Portal>
      {/* The occluder keeps native terminals and web tiles from drawing over the popup. */}
      <MenuPrimitive.Positioner className="chat-floating z-[130]" data-native-terminal-occluder="" side={side} align={align} sideOffset={sideOffset}>
        <MenuPrimitive.Popup
          className={cn(
            'max-h-(--available-height) min-w-48 overflow-y-auto rounded-lg border border-input bg-popover p-1 text-sm text-secondary-label shadow-[0_8px_24px_rgb(0_0_0/45%)] outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

const itemClass = 'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0'

export function MenuItem({ className, danger, ...props }: MenuPrimitive.Item.Props & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      className={cn(
        itemClass,
        danger && 'text-destructive data-[highlighted]:text-destructive',
        className,
      )}
      {...props}
    />
  )
}


/** A toggle row; the menu stays open so several can be flipped in one go. */
export function MenuCheckboxItem({ className, children, ...props }: MenuPrimitive.CheckboxItem.Props) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(itemClass, className)} {...props}>
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator><Check aria-hidden="true" /></MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator className={cn('my-1 h-px bg-border', className)} {...props} />
}
