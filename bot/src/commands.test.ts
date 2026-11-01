import { describe, expect, it, vi } from "vitest";
import { commandDefinitions, formatDictionary, syncCommands } from "./commands.js";
import { createEngines } from "./engines.js";

const definitions = commandDefinitions(
  createEngines({ openjtalkImage: "oj:1", voicevoxImage: "vv:1", voicevoxSpeaker: 3 }),
);

const guild = (id: string, set = vi.fn(async () => [])) => ({ id, commands: { set } });

describe("syncCommands", () => {
  it("replaces the global commands and clears every guild's commands", async () => {
    const application = { commands: { set: vi.fn(async () => []) } };
    const guilds = [guild("a"), guild("b")];

    await syncCommands(application, guilds, definitions, vi.fn());

    expect(application.commands.set).toHaveBeenCalledWith(definitions);
    for (const g of guilds) {
      expect(g.commands.set).toHaveBeenCalledWith([]);
    }
  });

  it("logs a guild that cannot be cleared and continues with the rest", async () => {
    const application = { commands: { set: vi.fn(async () => []) } };
    const blocked = guild("blocked", vi.fn().mockRejectedValue(new Error("Missing Access")));
    const next = guild("next");
    const log = vi.fn();

    await syncCommands(application, [blocked, next], definitions, log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("blocked"), expect.any(Error));
    expect(next.commands.set).toHaveBeenCalledWith([]);
  });

  it("fails when the global commands cannot be replaced", async () => {
    const application = { commands: { set: vi.fn().mockRejectedValue(new Error("Unauthorized")) } };

    await expect(syncCommands(application, [], definitions, vi.fn())).rejects.toThrow("Unauthorized");
  });

  it("defines the commands the bot handles", () => {
    expect(definitions.map((d) => d.name)).toEqual(["join", "leave", "voice", "dict"]);
  });
});

describe("formatDictionary", () => {
  it("lists entries and escapes Markdown", () => {
    expect(formatDictionary([{ word: "a_b_c", reading: "エー" }])).toEqual(["辞書(1件)\na\\_b\\_c → エー"]);
  });

  it("splits long lists without breaking an entry or exceeding the limit", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ word: `単語${i}`.padEnd(50, "あ"), reading: "い".repeat(100) }));

    const pages = formatDictionary(entries);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 2000)).toBe(true);
    expect(pages.join("\n").match(/→/g)).toHaveLength(200);
  });
});
