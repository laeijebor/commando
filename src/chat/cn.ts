import { cx, type CxOptions } from 'class-variance-authority'
import { extendTailwindMerge } from 'tailwind-merge'

// The theme's extra font size (chat.css). Unregistered, tailwind-merge reads
// text-2xs as a colour and drops it next to text-muted-foreground.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['2xs'] } } })

/** Class names for chat components (from t3code's `cn`). */
export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs))
}
