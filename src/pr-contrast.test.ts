import { describe, expect, it } from "bun:test";

// Pull request text (a badge's number and word, a card's title, an event line) is drawn in --text or
// --text-dim; only its glyph takes the state's colour, which several palettes keep under 4.5:1 for
// small text. This holds the text to 4.5:1 on every surface it sits on, in every theme block.
const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const pr = await Bun.file(new URL("./components/PullRequestBadge.css", import.meta.url)).text();
const panel = await Bun.file(new URL("./components/PullRequestPanel.css", import.meta.url)).text();

const blocks = [...css.matchAll(/(:root|\[data-theme="(?:dark|light)"\](?:\[data-palette="[\w-]+"\])?(?:,\s*\[data-theme="light"\]\[data-palette="[\w-]+"\])?)\s*\{([^}]*)\}/g)];
const read = (body: string) => new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
const base = read(blocks.find((b) => b[1] === ":root")![2]!);
const light = read(blocks.find((b) => b[1] === '[data-theme="light"]')![2]!);
const rgb = (value: string): number[] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  return m ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) : null;
};
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

describe("pull request text contrast", () => {
  it("draws the number and word in text colour and only the glyph in the state's", () => {
    expect(pr).toMatch(/\.pr-badge \{[^}]*color: var\(--text\);/);
    expect(pr).toMatch(/\.pr-badge-icon \{[^}]*color: var\(--pr-tone\);/);
    expect(panel).not.toMatch(/\.pr-card[^{]*\{[^}]*opacity:/);
  });

  it("keeps --text and --text-dim at 4.5:1 on every surface PR text sits on, in every theme", () => {
    const low: string[] = [];
    let compared = 0;
    for (const [, selector, body] of blocks) {
      if (selector === ":root") continue;
      const own = read(body!);
      const isLight = selector!.includes('"light"');
      const get = (token: string) => own.get(token) ?? (isLight ? light.get(token) : undefined) ?? base.get(token)!;
      for (const text of ["--text", "--text-dim"]) for (const surface of ["--bg", "--bg-panel", "--bg-hover"]) {
        const a = rgb(get(text)), b = rgb(get(surface));
        if (!a || !b) continue;
        compared += 1;
        if (ratio(a, b) < 4.5) low.push(`${selector} ${text} on ${surface}: ${ratio(a, b).toFixed(2)}`);
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(low).toEqual([]);
  });
});
