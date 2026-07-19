#!/usr/bin/env bun
// Bundles the browser-facing frontend/main.ts into frontend/main.js.
// index.html and style.css are plain static files and need no build step.

const root = new URL("..", import.meta.url);

const result = await Bun.build({
  entrypoints: [new URL("frontend/main.ts", root).pathname],
  outdir: new URL("frontend", root).pathname,
  naming: "main.js",
  target: "browser",
  sourcemap: "linked",
  minify: false,
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

console.log("built frontend/main.js");
