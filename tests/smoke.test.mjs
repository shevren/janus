import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.name, "janus");
assert.ok(pkg.engines.node.includes("22"));

const readme = readFileSync("README.md", "utf8");
assert.ok(readme.includes("Your cloud computer on your phone"));
assert.ok(!readme.includes("sslip.io"), "README should not mention sslip");
assert.ok(readme.includes("@JanusWorkBot"), "README should document unified bot");

console.log("tests passed");