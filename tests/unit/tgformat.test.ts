import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { balancedHtml, chunksOf, cleanResponse, markdownToHtml, sanitizeTgHtml, stripTags } from "../../services/api/src/tgformat.js";

describe("cleanResponse", () => {
  it("strips control tokens and junk prefixes", () => {
    assert.equal(cleanResponse("<|open|>responseПривет!"), "Привет!");
    assert.equal(cleanResponse("responseПривет!"), "Привет!");
    assert.equal(cleanResponse("output: done"), "done");
    assert.equal(cleanResponse("Ответ: всё готово"), "всё готово");
    assert.equal(cleanResponse("responses are fine"), "responses are fine");
  });
  it("trims filler ellipsis lines", () => {
    assert.equal(cleanResponse("...\n\nТекст\n…"), "Текст");
  });
});

describe("markdownToHtml", () => {
  it("converts bold, italic, strike, code, links", () => {
    const out = markdownToHtml("**b** __i__ ~~s~~ `c` [t](https://x.io/y)");
    assert.ok(out.includes("<b>b</b>"));
    assert.ok(out.includes("<i>i</i>"));
    assert.ok(out.includes("<s>s</s>"));
    assert.ok(out.includes("<code>c</code>"));
    assert.ok(out.includes('<a href="https://x.io/y">t</a>'));
  });
  it("ignores non-http links", () => {
    assert.equal(markdownToHtml("[t](javascript:alert(1))"), "[t](javascript:alert(1))");
  });
});

describe("sanitizeTgHtml", () => {
  it("keeps allowed tags, strips the rest, escapes bare brackets", () => {
    const out = sanitizeTgHtml('<b>hi</b><script>evil()</script><div>x</div> a<b>b');
    assert.ok(out.includes("<b>hi</b>"));
    assert.ok(!out.includes("<script>"));
    assert.ok(!out.includes("<div>"));
    assert.ok(out.includes("&lt;"));
  });
  it("keeps only http(s) links", () => {
    assert.ok(sanitizeTgHtml('<a href="https://a.io">t</a>').includes('<a href="https://a.io">'));
    assert.ok(!sanitizeTgHtml('<a href="ftp://a.io">t</a>').includes("<a "));
  });
  it("normalizes markdown leftovers from the model", () => {
    const out = sanitizeTgHtml("**bold** and [doc](https://d.io)");
    assert.ok(out.includes("<b>bold</b>"));
    assert.ok(out.includes('<a href="https://d.io">doc</a>'));
  });
});

describe("balancedHtml", () => {
  it("detects unbalanced tags", () => {
    assert.equal(balancedHtml("<b>x</b>"), true);
    assert.equal(balancedHtml("<b>x"), false);
    assert.equal(balancedHtml('a<a href="https://x.io">y'), false);
  });
});

describe("chunksOf", () => {
  it("keeps short text whole and splits long text", () => {
    assert.equal(chunksOf("short").length, 1);
    const big = Array.from({ length: 30 }, (_, i) => `para ${i} ` + "x".repeat(300)).join("\n\n");
    const parts = chunksOf(big, 1000);
    assert.ok(parts.length > 3);
    assert.ok(parts.every((p) => p.length <= 1000));
  });
});

describe("stripTags", () => {
  it("strips tags and unescapes", () => {
    assert.equal(stripTags("<b>a</b> &amp; &lt;x&gt;"), "a & <x>");
  });
});
