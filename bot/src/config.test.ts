import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const env = {
  DISCORD_TOKEN: "token",
  POD_NAMESPACE: "ns",
  POD_NAME: "bot",
  POD_UID: "uid",
  OPENJTALK_IMAGE: "oj:1",
  VOICEVOX_IMAGE: "vv:1",
};

describe("loadConfig", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["  ", null],
    [" 読み上げ中 ", "読み上げ中"],
  ])("ACTIVITY_NAME %j -> %j", (value, expected) => {
    expect(loadConfig({ ...env, ACTIVITY_NAME: value }).activityName).toBe(expected);
  });
});
