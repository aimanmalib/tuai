// Vite turns these imports into hashed asset URLs at build time.
declare module '*.mp4' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
// Content hash of docs/deck.pdf, set by vite.config.ts at build time.
declare const __TUAI_DECK_VERSION__: string;
