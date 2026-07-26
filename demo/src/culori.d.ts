// Minimal ambient types for the two culori entry points rhythm-color.ts uses (culori ships no bundled
// declarations for our resolution). Typed to exactly our usage: `interpolate([...], mode)` returns a
// sampler `(t) => Color`, and `rgb(color)` yields channel values we clamp to 0..255.
declare module 'culori' {
  export interface Color {
    readonly mode: string;
    [channel: string]: number | string | undefined;
  }
  export function interpolate(
    colors: ReadonlyArray<string | Color>,
    mode?: string,
  ): (t: number) => Color;
  export function rgb(color: string | Color): {
    mode: 'rgb';
    r: number;
    g: number;
    b: number;
    alpha?: number;
  };
}
