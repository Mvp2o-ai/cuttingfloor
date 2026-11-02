// wawoff2 (MIT): Google's woff2 decoder compiled to WebAssembly. It ships no types.
declare module 'wawoff2' {
  export function decompress(woff2: Uint8Array): Promise<Uint8Array>;
  export function compress(sfnt: Uint8Array): Promise<Uint8Array>;
}
