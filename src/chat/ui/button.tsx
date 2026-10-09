// Adapted from t3code (MIT, T3 Tools Inc.): apps/web/src/components/ui/button.tsx.
// Variants trimmed to the ones chat panes use; colours come from chat.css.
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-sm outline-none transition-[box-shadow,scale,background-color] [&:active:not([aria-haspopup])]:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-8 px-[11px]',
        sm: 'h-7 gap-1.5 px-[9px]',
        xs: 'h-6 gap-1 px-[7px] text-xs [&_svg:not([class*=\'size-\'])]:size-3.5',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-xs': 'size-6 [&_svg:not([class*=\'size-\'])]:size-3.5',
      },
      variant: {
        default: 'border-primary bg-primary text-primary-foreground [:hover,[data-pressed]]:bg-primary/90',
        outline: 'border-input bg-popover text-foreground [:hover,[data-pressed]]:bg-accent',
        ghost: 'border-transparent text-foreground [:hover,[data-pressed]]:bg-accent',
        'ghost-muted': 'border-transparent text-muted-foreground [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground',
        'destructive-outline': 'border-input bg-popover text-destructive-foreground [:hover,[data-pressed]]:border-destructive/40 [:hover,[data-pressed]]:bg-destructive/10',
        'warning-outline': 'border-warning/30 bg-warning-surface text-warning-foreground [:hover,[data-pressed]]:bg-warning/15',
      },
    },
  },
)

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

interface ButtonProps extends useRender.ComponentProps<'button'> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ className, size, variant })),
    'data-slot': 'button',
    type: render ? undefined : ('button' as const),
  }
  return useRender({ defaultTagName: 'button', props: mergeProps<'button'>(defaultProps, props), render })
}
