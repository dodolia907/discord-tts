import { describe, expect, it } from "vitest";
import { MAX_SPOKEN_CHARS, toSpeech, toUtterance } from "./text.js";

describe("toUtterance", () => {
  it.each([
    ["ぽんた", "こんにちは", "ぽんた、こんにちは"],
    ["<:logo:1>", "こんにちは", "こんにちは"],
    ["", "こんにちは", "こんにちは"],
    ["ぽんた", "<:only:1>", ""],
    ["ぽんた", "", ""],
  ])("%j + %j -> %j", (author, content, expected) => {
    expect(toUtterance(author, content)).toBe(expected);
  });

  it("does not count the name towards the message limit", () => {
    const body = "あ".repeat(MAX_SPOKEN_CHARS);
    expect(toUtterance("ぽんた", body)).toBe(`ぽんた、${body}`);
  });
});

describe("toSpeech", () => {
  it.each([
    ["見て https://example.com/a?b=1 これ", "見て URL これ"],
    ["<:smile:123456> やあ <a:wave:789>", "やあ"],
    ["前 ```js\nconst a = 1;\n``` 後", "前 コードブロック 後"],
    ["答えは ||秘密|| です", "答えは 伏せ字 です"],
    ["**太字** `code`\n次の行", "太字 code 次の行"],
    ["  ", ""],
    ["<:only:1>", ""],
  ])("%j -> %j", (input, expected) => {
    expect(toSpeech(input)).toBe(expected);
  });

  it("truncates by code point without splitting surrogate pairs", () => {
    const result = toSpeech("😀".repeat(MAX_SPOKEN_CHARS + 1));
    expect(result).toBe(`${"😀".repeat(MAX_SPOKEN_CHARS)} 以下略`);
  });

  it("keeps text at the limit intact", () => {
    const text = "あ".repeat(MAX_SPOKEN_CHARS);
    expect(toSpeech(text)).toBe(text);
  });
});
