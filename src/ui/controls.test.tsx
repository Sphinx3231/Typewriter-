// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, ConfirmButton, Field, IconButton, NumberInput, Segmented, Switch, ToastProvider, useToast } from "./controls";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Button", () => {
  it("renders an icon and a label, with variant and size classes", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" size="lg" icon={<i data-testid="ico" />} className="extra" onClick={onClick}>
        Start
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Start" });
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.className).toBe("btn btn--primary btn--lg extra");
    expect(btn.querySelector(".btn__icon")?.getAttribute("aria-hidden")).toBe("true");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults to a secondary medium button and omits empty icon and label slots", () => {
    render(<Button aria-label="Empty" />);
    const btn = screen.getByRole("button", { name: "Empty" });
    expect(btn.className).toBe("btn btn--secondary btn--md ");
    expect(btn.querySelector(".btn__icon")).toBeNull();
    expect(btn.querySelector(".btn__label")).toBeNull();
  });

  it("does not fire when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("uses the label as accessible name and tooltip", async () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Delete this session" onClick={onClick}>
        <svg />
      </IconButton>,
    );
    const btn = screen.getByRole("button", { name: "Delete this session" });
    expect(btn.getAttribute("title")).toBe("Delete this session");
    expect(btn.className).toBe("icon-btn ");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("prefers an explicit title", () => {
    render(<IconButton label="Close" title="Close (Esc)" className="x" />);
    const btn = screen.getByRole("button", { name: "Close" });
    expect(btn.getAttribute("title")).toBe("Close (Esc)");
    expect(btn.className).toBe("icon-btn x");
  });
});

describe("Switch", () => {
  it("toggles and exposes checked state, label and description", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Typing sounds" description="Generated on your device." />);
    const sw = screen.getByRole("switch", { name: "Typing sounds" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toBe("Off");
    const descId = sw.getAttribute("aria-describedby")!;
    expect(document.getElementById(descId)?.textContent).toBe("Generated on your device.");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("turns off when checked, uses a given id, and has no description link without one", async () => {
    const onChange = vi.fn();
    render(<Switch id="snd" checked onChange={onChange} label="Sound" />);
    const sw = screen.getByRole("switch", { name: "Sound" });
    expect(sw.id).toBe("snd");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.textContent).toBe("On");
    expect(sw.hasAttribute("aria-describedby")).toBe(false);
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("ignores clicks when disabled", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Locked" disabled />);
    const sw = screen.getByRole("switch", { name: "Locked" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Segmented", () => {
  const options = [
    { value: "a", label: "Alpha", icon: <i />, title: "First" },
    { value: "b", label: "Beta" },
    { value: "c", label: "Gamma" },
  ];

  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [v, setV] = useState("a");
    return (
      <Segmented
        label="Pick one"
        id="seg"
        size="sm"
        value={v}
        options={options}
        onChange={(x) => {
          onChange(x);
          setV(x);
        }}
      />
    );
  }

  it("renders a radio group with one checked, focusable option", () => {
    render(<Segmented label="Pick one" value="b" options={options} onChange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Pick one" });
    expect(group.className).toBe("segmented segmented--md");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios[0].getAttribute("title")).toBe("First");
    expect(radios[0].querySelector(".segmented__icon")).not.toBeNull();
    expect(radios[1].querySelector(".segmented__icon")).toBeNull();
    expect(radios[1].className).toContain("is-on");
  });

  it("selects on click", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Gamma" }));
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(screen.getByRole("radio", { name: "Gamma" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves selection and focus with the arrow keys, wrapping around", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const [a, b, c] = screen.getAllByRole("radio");
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(c);
    fireEvent.keyDown(c, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(c, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("b");
  });

  it("ignores other keys", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const ev = fireEvent.keyDown(screen.getAllByRole("radio")[0], { key: "Enter" });
    expect(ev).toBe(true); // not prevented
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Field", () => {
  it("shows an error as an alert instead of the hint", () => {
    const { container } = render(
      <Field label="Duration" htmlFor="d" hint="A hint" error="Too short">
        <input id="d" />
      </Field>,
    );
    expect(screen.getByLabelText("Duration").id).toBe("d");
    expect(screen.getByRole("alert").textContent).toBe("Too short");
    expect(screen.queryByText("A hint")).toBeNull();
    expect(container.firstElementChild!.className).toContain("field--error");
  });

  it("shows the hint when there is no error", () => {
    const { container } = render(
      <Field label="Duration" hint="A hint" error={null}>
        <span />
      </Field>,
    );
    expect(screen.getByText("A hint").className).toBe("field__hint");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.firstElementChild!.className).not.toContain("field--error");
  });

  it("shows neither without hint or error", () => {
    const { container } = render(
      <Field label="Plain">
        <span />
      </Field>,
    );
    expect(container.querySelector(".field__hint, .field__error")).toBeNull();
  });
});

describe("NumberInput", () => {
  function setup(props: Partial<Parameters<typeof NumberInput>[0]> = {}) {
    const onCommit = vi.fn();
    const utils = render(<NumberInput value={10} min={0} max={59} ariaLabel="Seconds" suffix="sec" onCommit={onCommit} {...props} />);
    const input = screen.getByRole("spinbutton", { name: "Seconds" }) as HTMLInputElement;
    return { ...utils, onCommit, input };
  }

  it("commits a typed value on blur", async () => {
    const { input, onCommit } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "42");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledWith(42);
    expect(input.value).toBe("42");
  });

  it("commits on Enter and ignores other keys", async () => {
    const { input, onCommit } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "7");
    fireEvent.keyDown(input, { key: "a" });
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.type(input, "{Enter}");
    expect(onCommit).toHaveBeenCalledWith(7);
  });

  it("clamps to the allowed range", async () => {
    const { input, onCommit } = setup();
    await userEvent.clear(input);
    await userEvent.type(input, "99{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith(59);
    expect(input.value).toBe("59");
    await userEvent.clear(input);
    await userEvent.type(input, "-5{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith(0);
    expect(input.value).toBe("0");
  });

  it("restores the current value when the field is emptied", async () => {
    const { input, onCommit } = setup();
    await userEvent.clear(input);
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("restores the current value for a non-finite number", () => {
    const { input, onCommit } = setup();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1e999" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("does not commit an unchanged value", async () => {
    const { input, onCommit } = setup();
    await userEvent.click(input);
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("follows the value prop while not focused, but keeps the draft while editing", async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<NumberInput value={10} min={0} max={59} ariaLabel="Seconds" onCommit={onCommit} />);
    const input = screen.getByRole("spinbutton", { name: "Seconds" }) as HTMLInputElement;
    rerender(<NumberInput value={20} min={0} max={59} ariaLabel="Seconds" onCommit={onCommit} />);
    expect(input.value).toBe("20");
    await userEvent.clear(input);
    await userEvent.type(input, "3");
    rerender(<NumberInput value={30} min={0} max={59} ariaLabel="Seconds" onCommit={onCommit} />);
    expect(input.value).toBe("3");
  });

  it("shows suffix, invalid and disabled state", () => {
    const { input, container } = setup({ invalid: true, disabled: true, id: "n1", step: 50 });
    expect(container.querySelector(".num-input__suffix")?.textContent).toBe("sec");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.disabled).toBe(true);
    expect(input.id).toBe("n1");
    expect(input.step).toBe("50");
    expect(container.firstElementChild!.className).toContain("is-invalid");
    expect(container.firstElementChild!.className).toContain("is-disabled");
  });

  it("has no suffix or invalid marker by default", () => {
    const { input, container } = setup({ suffix: undefined });
    expect(container.querySelector(".num-input__suffix")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("toasts", () => {
  function Pusher() {
    const toast = useToast();
    return (
      <>
        <button onClick={() => toast("Saved")}>info</button>
        <button onClick={() => toast("Copied", "success")}>success</button>
        <button onClick={() => toast("Failed", "error")}>error</button>
      </>
    );
  }

  it("shows toasts in a polite live region and removes them after a while", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByText("info"));
    fireEvent.click(screen.getByText("success"));
    const toasts = region.querySelectorAll(".toast");
    expect([...toasts].map((t) => [t.textContent, t.className])).toEqual([
      ["Saved", "toast toast--info"],
      ["Copied", "toast toast--success"],
    ]);
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(region.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("keeps at most three toasts at once", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("info"));
    fireEvent.click(screen.getByText("success"));
    fireEvent.click(screen.getByText("error"));
    fireEvent.click(screen.getByText("info"));
    const texts = [...screen.getByRole("status").querySelectorAll(".toast")].map((t) => t.textContent);
    expect(texts).toEqual(["Copied", "Failed", "Saved"]);
  });

  it("is a harmless no-op outside a provider", () => {
    render(<Pusher />);
    expect(() => fireEvent.click(screen.getByText("info"))).not.toThrow();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ConfirmButton", () => {
  it("arms on the first click and confirms on the second", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Clear all text?" icon={<i />}>
        Clear
      </ConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Clear" });
    expect(btn.className).toContain("btn--ghost");
    expect(btn.className).toContain("btn--sm");
    await userEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe("Clear all text?");
    expect(btn.className).toContain("btn--danger");
    await userEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Clear");
  });

  it("disarms after three seconds", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?" variant="secondary" size="md">
        Reset
      </ConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Reset" });
    expect(btn.className).toContain("btn--secondary");
    fireEvent.click(btn);
    expect(btn.textContent).toBe("Sure?");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(btn.textContent).toBe("Reset");
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("disarms when focus leaves", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?">
        Reset
      </ConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Reset" });
    await userEvent.click(btn);
    expect(btn.textContent).toBe("Sure?");
    fireEvent.blur(btn);
    expect(btn.textContent).toBe("Reset");
  });

  it("cannot be used while disabled", async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?" disabled>
        Reset
      </ConfirmButton>,
    );
    const btn = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.textContent).toBe("Reset");
  });
});
