import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { speechChunks, speechText } from "../src/core/speech-text.ts";

const raw = String.raw;

describe("speechText", () => {
	it("keeps headings, nested formatting, and link labels without URLs", () => {
		const markdown = [
			"# Welcome",
			"",
			"Read **clear *nested* prose** at [the **lesson** page](https://example.com/private?q=1).",
		].join("\n");
		assert.equal(speechText(markdown), "Welcome Read clear nested prose at the lesson page.");
	});

	it("omits code, math, Mermaid, HTML, and images", () => {
		const markdown = raw`Keep this before \`secret()\` and after.

$x + 1$ \(y + 2\) \[z + 3\]

~~~mermaid
graph TD
A --> B
~~~

\`\`\`ts
const hidden = true;
\`\`\`

<div>hidden HTML</div>

![hidden image](secret.png)

Finish here.`.replaceAll("\\`", "`");
		assert.equal(speechText(markdown), "Keep this before and after. Finish here.");
	});

	it("preserves Arabic, Chinese, Latin, and unmatched currency text", () => {
		assert.equal(speechText("## مرحبًا بالعالم\n\n你好，世界。 **Café** costs $5."), "مرحبًا بالعالم 你好，世界。 Café costs $5.");
	});

	it("returns empty text when no prose remains", () => {
		assert.equal(speechText("```js\nconst x = 1;\n```\n\n$$\nx + 1\n$$"), "");
		assert.equal(speechText(" \n\t"), "");
	});
});

describe("speechChunks", () => {
	it("uses Unicode sentence boundaries without choosing a language", () => {
		const text = "مرحبًا بالعالم؟ 你好世界。 Café déjà vu!";
		const chunks = speechChunks(text, 16);
		assert.deepEqual(chunks, ["مرحبًا بالعالم؟", "你好世界。", "Café déjà vu!"]);
		assert.ok(chunks.every(chunk => [...chunk].length <= 16));
	});

	it("keeps every word in long punctuation-free text", () => {
		const text = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
		const chunks = speechChunks(text, 40);
		assert.ok(chunks.length > 1);
		assert.ok(chunks.every(chunk => [...chunk].length <= 40));
		assert.equal(chunks.join(" "), text);
	});

	it("splits only a huge token at Unicode character boundaries", () => {
		const token = "𠮷界".repeat(13);
		const chunks = speechChunks(token, 7);
		assert.ok(chunks.every(chunk => [...chunk].length <= 7));
		assert.equal(chunks.join(""), token);
	});

	it("handles empty text and rejects invalid lengths", () => {
		assert.deepEqual(speechChunks(" \n "), []);
		for (const length of [0, -1, 1.5, Number.NaN]) {
			assert.throws(() => speechChunks("text", length), {
				name: "RangeError",
				message: "maxLength must be a positive integer",
			});
		}
	});
});
