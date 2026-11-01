import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReplacer, FileDictionary, MAX_ENTRIES, MAX_READING_CHARS, MAX_WORD_CHARS } from "./dictionary.js";
import { UserFacingError } from "./session.js";

describe("createReplacer", () => {
  const entry = (word: string, reading: string) => ({ word, reading });

  it.each<[string, string]>([
    ["GitHubを見る", "ギットハブを見る"],
    ["githubを見る", "ギットハブを見る"],
    ["関係ない文", "関係ない文"],
    ["AIチャットとAI", "エーアイチャットとエーアイ"],
    ["C++とa.b", "シープラプラとエービー"],
    ["axb", "axb"],
    ["foo-bar", "フーバー"],
  ])("%j -> %j", (input, expected) => {
    const replace = createReplacer([
      entry("GitHub", "ギットハブ"),
      entry("AI", "エーアイ"),
      entry("AIチャット", "エーアイチャット"),
      entry("C++", "シープラプラ"),
      entry("a.b", "エービー"),
      entry("foo-bar", "フーバー"),
    ]);
    expect(replace(input)).toBe(expected);
  });

  it("does not replace a reading again", () => {
    const replace = createReplacer([entry("A", "B"), entry("B", "C")]);
    expect(replace("A")).toBe("B");
  });

  it("leaves text alone with an empty dictionary", () => {
    expect(createReplacer([])("そのまま")).toBe("そのまま");
  });
});

describe("FileDictionary", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dict-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    await expect(new FileDictionary(directory).list("g")).resolves.toEqual([]);
  });

  it("persists across instances and keeps guilds apart", async () => {
    await new FileDictionary(directory).add("g", " GitHub ", " ギットハブ ");

    const reopened = new FileDictionary(directory);
    await expect(reopened.list("g")).resolves.toEqual([{ word: "GitHub", reading: "ギットハブ" }]);
    await expect(reopened.list("other")).resolves.toEqual([]);
  });

  it("overwrites the same word regardless of case", async () => {
    const dictionary = new FileDictionary(directory);

    await expect(dictionary.add("g", "GitHub", "一")).resolves.toBe(false);
    await expect(dictionary.add("g", "github", "二")).resolves.toBe(true);

    await expect(dictionary.list("g")).resolves.toEqual([{ word: "github", reading: "二" }]);
  });

  it("removes a word and reports a missing one", async () => {
    const dictionary = new FileDictionary(directory);
    await dictionary.add("g", "GitHub", "ギットハブ");

    await expect(dictionary.remove("g", "nothing")).resolves.toBe(false);
    await expect(dictionary.remove("g", "github")).resolves.toBe(true);

    await expect(new FileDictionary(directory).list("g")).resolves.toEqual([]);
  });

  it("does not lose overlapping writes or leave temporary files", async () => {
    const dictionary = new FileDictionary(directory);

    await Promise.all(Array.from({ length: 20 }, (_, i) => dictionary.add("g", `w${i}`, "r")));

    await expect(new FileDictionary(directory).list("g")).resolves.toHaveLength(20);
    await expect(readdir(directory)).resolves.toEqual(["g.json"]);
  });

  it.each([
    ["  ", "読み"],
    ["単語", " "],
    ["あ".repeat(MAX_WORD_CHARS + 1), "読み"],
    ["単語", "あ".repeat(MAX_READING_CHARS + 1)],
  ])("rejects invalid input %j / %j", async (word, reading) => {
    await expect(new FileDictionary(directory).add("g", word, reading)).rejects.toBeInstanceOf(UserFacingError);
  });

  it("enforces the entry limit but still allows overwriting", async () => {
    const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({ word: `w${i}`, reading: "r" }));
    await writeFile(join(directory, "g.json"), JSON.stringify(entries));
    const dictionary = new FileDictionary(directory);

    await expect(dictionary.add("g", "new", "r")).rejects.toBeInstanceOf(UserFacingError);
    await expect(dictionary.add("g", "w0", "変更")).resolves.toBe(true);
  });

  it("keeps working after a failed write", async () => {
    const dictionary = new FileDictionary(directory);
    await expect(dictionary.add("g", "", "r")).rejects.toBeInstanceOf(UserFacingError);

    await expect(dictionary.add("g", "単語", "読み")).resolves.toBe(false);
  });

  it("refuses to overwrite a corrupt file", async () => {
    await writeFile(join(directory, "g.json"), "{broken");
    const dictionary = new FileDictionary(directory);

    await expect(dictionary.add("g", "単語", "読み")).rejects.toThrow(SyntaxError);
  });
});
