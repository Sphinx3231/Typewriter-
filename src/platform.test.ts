import { afterEach, describe, expect, it, vi } from "vitest";
import { currentHost, isDesktop, isExtension } from "./platform";

afterEach(() => {
  vi.unstubAllGlobals();
});

const extensionPage = (runtime: { id?: string } = { id: "abcdefghijklmnop" }) => {
  vi.stubGlobal("location", { protocol: "chrome-extension:" });
  vi.stubGlobal("chrome", { runtime });
};

describe("platform detection", () => {
  it("is the plain web app when there is no window, no Tauri and no extension", () => {
    expect(typeof window).toBe("undefined");
    expect(isDesktop()).toBe(false);
    expect(isExtension()).toBe(false);
    expect(currentHost()).toBe("web");
  });

  it("a browser window without Tauri internals is the web app", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("location", { protocol: "https:" });
    expect(isDesktop()).toBe(false);
    expect(currentHost()).toBe("web");
  });

  it("detects the Tauri desktop shell", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isDesktop()).toBe(true);
    expect(currentHost()).toBe("desktop");
  });

  it("desktop wins even if extension globals are present", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    extensionPage();
    expect(currentHost()).toBe("desktop");
  });

  it("detects a Chrome extension page", () => {
    extensionPage();
    expect(isExtension()).toBe(true);
    expect(currentHost()).toBe("extension");
  });

  it("an extension page needs both the scheme and a runtime id", () => {
    extensionPage({});
    expect(isExtension()).toBe(false);
    extensionPage({ id: "" });
    expect(isExtension()).toBe(false);

    vi.stubGlobal("chrome", undefined);
    expect(isExtension()).toBe(false);

    vi.stubGlobal("chrome", {});
    expect(isExtension()).toBe(false);

    vi.stubGlobal("location", { protocol: "https:" });
    vi.stubGlobal("chrome", { runtime: { id: "abc" } });
    expect(isExtension()).toBe(false);
    expect(currentHost()).toBe("web");
  });
});
