import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { readContentSpans } from "./content-reader.ts";

type SpeechNode = RootContent | { type: "root"; children: RootContent[] };

const skippedTypes = new Set(["code", "inlineCode", "html", "image", "imageReference", "definition"]);
const spacedParents = new Set(["root", "blockquote", "list", "listItem", "table", "tableRow"]);

function nodeText(node: SpeechNode): string {
	if (skippedTypes.has(node.type)) return "";
	if (node.type === "text") return node.value;
	if (node.type === "break") return " ";
	if (!("children" in node)) return "";
	const separator = spacedParents.has(node.type) ? " " : "";
	return node.children.map(child => nodeText(child)).filter(Boolean).join(separator);
}

/** Literal ranges become gaps so words on either side cannot merge. */
export function speechText(markdown: string): string {
	const prose = readContentSpans(markdown).map(span => {
		if (span.kind === "prose") return span.raw;
		return span.raw.includes("\n") ? "\n\n" : " ";
	}).join("");
	return nodeText(fromMarkdown(prose)).replace(/\s+/gu, " ").trim();
}

const sentenceMarks = new Set([".", "!", "?", "。", "！", "？", "؟"]);
const sentenceClosers = new Set(["\"", "'", "’", "”", "»", ")", "]", "}", "）", "】", "》"]);

function sentenceBoundary(chars: string[], index: number): boolean {
	if (index <= 0 || sentenceClosers.has(chars[index] ?? "")) return false;
	let mark = index - 1;
	while (mark >= 0 && sentenceClosers.has(chars[mark] ?? "")) mark--;
	if (!sentenceMarks.has(chars[mark] ?? "")) return false;
	// A dot inside a token is not a sentence stop.
	return chars[mark] !== "." || index === chars.length || chars[index] === " ";
}

/** Count code points so non-BMP characters are never cut in half. */
export function speechChunks(text: string, maxLength = 400): string[] {
	if (!Number.isInteger(maxLength) || maxLength <= 0) {
		throw new RangeError("maxLength must be a positive integer");
	}
	const clean = text.replace(/\s+/gu, " ").trim();
	if (!clean) return [];
	const chars = [...clean];
	const chunks: string[] = [];
	for (let start = 0; start < chars.length;) {
		const limit = Math.min(start + maxLength, chars.length);
		if (limit === chars.length) {
			chunks.push(chars.slice(start).join(""));
			break;
		}
		let end = 0;
		for (let i = start + 1; i <= limit; i++) {
			if (sentenceBoundary(chars, i)) end = i;
		}
		if (!end) {
			for (let i = limit - 1; i > start; i--) {
				if (chars[i] === " ") { end = i; break; }
			}
		}
		// Only an oversized token should need a hard character boundary.
		if (!end) end = limit;
		chunks.push(chars.slice(start, end).join(""));
		start = end;
		if (chars[start] === " ") start++;
	}
	return chunks;
}
