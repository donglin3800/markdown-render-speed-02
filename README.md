# Faster Markdown Renderer

A dependency-free Markdown renderer written for the make.fun
markdown-render-speed-02 bounty. `parse(markdown)` returns exactly the HTML
that marked 18.1.3 produces with its default options (GFM on, breaks off,
pedantic off, async off), byte for byte.

The implementation is a clean-room block/inline lexer plus renderer. The
hot loops run on a cursor with sticky patterns instead of re-slicing the
input, which is where most of the speed over marked comes from.

- `parse.js` — the renderer (`export function parse(markdown)`).
- `main.ts` — driver: reads `/input/cases.json`, writes `/output/html.json`.
