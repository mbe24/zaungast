// Shared Observable Plot helpers. `PlotOptions` replaces the repeated
// `as Parameters<typeof Plot.plot>[0]` casts; `plotStyle` centralises the root style string (applied to
// the svg so tick labels inherit the size). Type-only Plot import → no runtime dependency here.
import type * as Plot from '@observablehq/plot';

export type PlotOptions = Parameters<typeof Plot.plot>[0];

// Root style for a Plot figure. Font size varies by context: hero Wrapped charts 16px, the secondary
// race volume chart 14px.
export const plotStyle = (fontPx = 16): string =>
	`background:transparent;color:var(--muted-foreground);font-family:inherit;font-size:${fontPx}px;`;
