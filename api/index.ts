// Vercel's entry point. The whole gateway stays in lazypath.ts so it is still one
// copy-pasteable file; this only re-exports its Node request handler.
export { default } from "../lazypath.ts";