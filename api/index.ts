// Vercel's entry point. The whole gateway stays in lazypath.ts so it is still one
// copy-pasteable file; `npm run vercel-build` strips its types into lazypath.js next to it.
// The specifier must stay .js: Vercel does not bundle, so a .ts import is never compiled.
export { default } from "../lazypath.js";