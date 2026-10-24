/** Runs SlopMonster's checker off the page's main thread, so long texts never freeze the UI. */
import { handle, type Request } from "./protocol";

// Typed by hand: the app is compiled with the DOM library, whose `self` is a window.
const scope = self as unknown as { onmessage: ((e: MessageEvent<Request>) => void) | null; postMessage(message: unknown): void };
scope.onmessage = (e) => scope.postMessage(handle(e.data));
