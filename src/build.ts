/** Replaced at build time (see scripts/build-info.mjs). */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const APP_COMMIT = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "dev";
