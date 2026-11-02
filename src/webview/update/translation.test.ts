// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { extractChangelog, translationLanguage } from "./translation";

afterEach(() => {
  delete window.__OC_UPDATE_LANG__;
});

describe("translationLanguage", () => {
  it("returns undefined when the display language is missing or English", () => {
    expect(translationLanguage()).toBeUndefined();
    window.__OC_UPDATE_LANG__ = "en";
    expect(translationLanguage()).toBeUndefined();
    window.__OC_UPDATE_LANG__ = "en-us";
    expect(translationLanguage()).toBeUndefined();
    window.__OC_UPDATE_LANG__ = "";
    expect(translationLanguage()).toBeUndefined();
  });

  it("returns the language code unchanged for non-English UIs", () => {
    window.__OC_UPDATE_LANG__ = "zh-cn";
    expect(translationLanguage()).toBe("zh-cn");
    window.__OC_UPDATE_LANG__ = "ja";
    expect(translationLanguage()).toBe("ja");
  });
});

describe("extractChangelog", () => {
  it("keeps inline code and links out of the translatable text", () => {
    const extracted = extractChangelog(
      '<p>Run <code>npm i</code> then <a href="https://opencode.ai">read docs</a></p>',
    );

    expect(extracted.blocks).toEqual([{ id: "b0", text: "Run ⟦0⟧ then ⟦1⟧" }]);
  });

  it("protects version numbers, issue refs and URLs", () => {
    const extracted = extractChangelog(
      "<p>Fixed in 1.2.3 and v2.0.0, see #123 at https://opencode.ai/changelog</p>",
    );

    expect(extracted.blocks[0]?.text).toBe(
      "Fixed in ⟦0⟧ and ⟦1⟧, see ⟦2⟧ at ⟦3⟧",
    );
  });

  it("skips pre content, whitespace-only blocks and numbers blocks in DOM order", () => {
    const extracted = extractChangelog(
      "<pre><p>code block</p></pre><h2> </h2><h2>Heading</h2><p>Body</p>",
    );

    expect(extracted.blocks).toEqual([
      { id: "b0", text: "Heading" },
      { id: "b1", text: "Body" },
    ]);
  });

  it("rebuilds structure with translated text, code and links in order", () => {
    const extracted = extractChangelog(
      '<p>Run <code>npm i</code> then <a href="https://opencode.ai">read docs</a></p>',
    );

    const html = extracted.render({
      b0: "先运行 ⟦0⟧ 再阅读 ⟦1⟧",
    });

    expect(html).toContain("<code>npm i</code>");
    expect(html).toContain('<a href="https://opencode.ai">read docs</a>');
    expect(html.indexOf("先运行")).toBeLessThan(html.indexOf("<code>"));
    expect(html.indexOf("<code>")).toBeLessThan(html.indexOf("再阅读"));
    expect(html.indexOf("再阅读")).toBeLessThan(html.indexOf("<a "));
    expect(html).not.toContain("⟦");
  });

  it("appends placeholders the translation dropped so links survive", () => {
    const extracted = extractChangelog(
      '<p>Run <code>npm i</code> then <a href="https://opencode.ai">read docs</a></p>',
    );

    const html = extracted.render({ b0: "已翻译" });

    expect(html).toContain("已翻译");
    expect(html).toContain("<code>npm i</code>");
    expect(html).toContain('<a href="https://opencode.ai">read docs</a>');
    expect(html.indexOf("已翻译")).toBeLessThan(html.indexOf("<code>"));
    expect(html).not.toContain("⟦");
  });

  it("keeps the original text for blocks the host did not translate", () => {
    const extracted = extractChangelog("<p>First</p><p>Second</p>");

    const html = extracted.render({ b0: "第一" });

    expect(html).toContain("第一");
    expect(html).toContain("Second");
    expect(html).not.toContain("First");
  });

  it("leaves nested lists in place while translating the parent block", () => {
    const extracted = extractChangelog(
      "<ul><li>Intro<ul><li>Sub</li></ul></li></ul>",
    );

    expect(extracted.blocks.map((block) => block.text)).toEqual([
      "Intro",
      "Sub",
    ]);

    const html = extracted.render({ b0: "介绍", b1: "子项" });

    expect(html).toContain("<ul>");
    expect(html).toContain("介绍");
    expect(html).toContain("子项");
    expect(html).not.toContain("data-ocu-cl-nested");
  });
});
