// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

it("mounts the app into #root with the toast provider and fades out the launch splash", async () => {
  const root = document.createElement("div");
  root.id = "root";
  const boot = document.createElement("div");
  boot.id = "boot";
  document.body.append(boot, root);

  await act(async () => {
    await import("./main");
  });

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workspace");
  expect(screen.getByTestId("editor")).toBeTruthy();
  // The toast region from ToastProvider is mounted next to the app.
  expect(document.querySelector(".toasts")).toBeTruthy();
  // markReady ran after mount.
  expect(boot.classList.contains("is-done")).toBe(true);
});
