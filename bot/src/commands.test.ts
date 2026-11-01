import { describe, expect, it, vi } from "vitest";
import { commandDefinitions, syncCommands } from "./commands.js";
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
    expect(definitions.map((d) => d.name)).toEqual(["join", "leave", "voice"]);
  });
});
