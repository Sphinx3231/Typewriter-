import { describe, expect, it } from "vitest";
import { quitRisk } from "./QuitGuard";

describe("quit protection", () => {
  it("closes without asking when nothing would be lost", () => {
    expect(quitRisk("", false, "empty")).toBeNull();
    expect(quitRisk("   \n", false, "ready")).toBeNull();
    expect(quitRisk("kept", true, "completed")).toBeNull();
  });
  it("asks when unsaved text would be lost", () => {
    expect(quitRisk("my essay", false, "ready")).toEqual({ running: false, unsavedText: true });
    expect(quitRisk("my essay", false, "stopped")).toEqual({ running: false, unsavedText: true });
  });
  it("asks while a session is running or paused, even if the text is remembered", () => {
    expect(quitRisk("x", true, "playing")).toEqual({ running: true, unsavedText: false });
    expect(quitRisk("x", true, "paused")).toEqual({ running: true, unsavedText: false });
    expect(quitRisk("x", false, "playing")).toEqual({ running: true, unsavedText: true });
  });
});
