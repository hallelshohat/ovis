import { describe, expect, it } from "bun:test";
import { Glob } from "bun";

const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();

/** Every `@media <query> { ... }` body, found by matching braces. */
function mediaBodies(query: string): string[] {
  const bodies: string[] = [];
  for (let start = css.indexOf(`@media ${query} {`); start >= 0; start = css.indexOf(`@media ${query} {`, start + 1)) {
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      if (depth === 0) { bodies.push(css.slice(open + 1, i)); break; }
    }
  }
  return bodies;
}

describe("the workbench's shared styles", () => {
  it("defines its tokens on :root", () => {
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));
    for (const token of ["--panel-inset", "--panel-radius", "--inspector-w", "--side-sheet-w", "--side-sheet-w-wide", "--timeline-rail", "--timeline-node", "--dur-slow", "--ease-in", "--pr-open", "--pr-failing", "--pr-draft", "--pr-review", "--pr-merged"]) {
      expect(root).toContain(`${token}:`);
    }
  });

  it("opens a form dialog as a sheet down the right side from 641px", () => {
    const desktop = mediaBodies("(min-width: 641px)").join("\n");
    expect(desktop).toMatch(/\.modal-scrim:has\([^{]*\.new-session-modal[^{]*\)\s*\{[^}]*justify-content: flex-end;/);
    expect(desktop).toContain("animation: side-sheet-in");
    expect(desktop).toContain("animation: side-sheet-out");
    expect(desktop).toContain("animation: modal-pop-in");
  });

  it("stills every new animation when the person asks for reduced motion", () => {
    for (const name of ["side-sheet-in", "side-sheet-out", "modal-pop-in", "modal-pop-out", "popover-in", "fade-in"]) expect(css).toContain(`@keyframes ${name} `);
    const reduced = mediaBodies("(prefers-reduced-motion: reduce)").join("\n");
    for (const selector of [".modal-scrim.is-leaving", ".modal-scrim.is-leaving > *", ".menu"]) expect(reduced).toContain(selector);
  });

  it("draws one section label, which the components take by class", async () => {
    expect(css).toMatch(/\.section-label,\s*\.field-label,\s*\.menu-heading\s*\{[^}]*text-transform: uppercase;/);
    const offenders: string[] = [];
    for (const file of new Glob("components/**/*.css").scanSync({ cwd: new URL(".", import.meta.url).pathname })) {
      const text = await Bun.file(new URL(file, import.meta.url)).text();
      for (const [, selector, body] of text.matchAll(/([^{}]*(?:section-label|menu-heading|field-label)[^{}]*)\{([^}]*)\}/g)) {
        if (/text-transform|font-size|letter-spacing/.test(body!)) offenders.push(`${file}: ${selector!.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
