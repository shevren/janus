import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDdg } from "../../services/api/src/daily.js";

const HTML = `
<html><body>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjack&amp;rut=x">Jack Russell</a>
<a class="result__snippet" href="x">Small terrier dog</a>
<a rel="nofollow" class="result__a" href="https://second.io/page">Second</a>
<a class="result__snippet" href="x">Second snippet</a>
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjack">Jack Russell</a>
</body></html>`;

describe("parseDdg", () => {
  it("extracts titles, urls and snippets, dedupes", () => {
    const res = parseDdg(HTML);
    assert.equal(res.length, 2);
    assert.equal(res[0].url, "https://example.com/jack");
    assert.equal(res[0].title, "Jack Russell");
    assert.equal(res[0].snippet, "Small terrier dog");
    assert.equal(res[1].url, "https://second.io/page");
  });
  it("returns empty on garbage", () => {
    assert.deepEqual(parseDdg("<html>nothing</html>"), []);
  });
});
