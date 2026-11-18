// Vercel transpiles api/ files one at a time and only compiles TS inside api/, so the
// gateway must reach the function as plain .js. Node strips the types: no bundler, no deps.
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const js = stripTypeScriptTypes(readFileSync("lazypath.ts", "utf8"));
writeFileSync("lazypath.js", js);
console.log(`lazypath.js written (${js.length} bytes)`);