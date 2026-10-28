import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { Inspector } from "./Inspector.tsx";

Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });

describe("the inspector column", () => {
  it("is a named complementary region with its head and a close button", () => {
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Inspector, { title: "Pull requests", onClose: () => {} }, "body") }));
    expect(html).toContain('class="inspector"');
    expect(html).toContain('role="complementary"');
    expect(html).toContain('aria-label="Pull requests"');
    expect(html).toContain('class="inspector-title section-label">Pull requests</h2>');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<div class="inspector-body">body</div>');
  });
});
