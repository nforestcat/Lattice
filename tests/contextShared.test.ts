import { describe, expect, it } from "vitest";
import { PRESETS, presetForSettings } from "../src/ui/hooks/contextShared";

describe("presetForSettings", () => {
  it("keeps custom preset when short mode does not match the current purpose", () => {
    expect(presetForSettings(PRESETS.ask.purpose, "short")).toBe("custom");
  });

  it("returns the matching preset for known purpose and mode pairs", () => {
    expect(presetForSettings(PRESETS.summarize.purpose, "short")).toBe("summarize");
  });
});
