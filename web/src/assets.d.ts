// Vite turns these imports into hashed asset URLs at build time.
declare module '*.mp4' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
