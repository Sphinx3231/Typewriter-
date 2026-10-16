import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme/tokens.css";
import "./styles/app.css";
import { isDesktop } from "./desktop/bridge";
import { ToastProvider } from "./ui/controls";

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

// Fade out the launch splash once the first frame of the app is on screen.
// In the desktop app the window starts hidden and is shown here, already themed.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    if (isDesktop()) void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().show());
    const boot = document.getElementById("boot");
    if (!boot) return;
    boot.classList.add("is-done");
    setTimeout(() => boot.remove(), 400);
  }),
);
