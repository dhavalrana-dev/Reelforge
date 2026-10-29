import { chromium, type Browser } from "playwright-core";

/** Flags that remove machine-dependent rendering differences where Chromium allows it. */
const DETERMINISTIC_ARGS = [
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
];

/**
 * REELFORGE_CHROMIUM (an executable path) wins. Otherwise a Playwright-managed
 * Chromium, then the system Edge or Chrome. The installer should ship a pinned
 * Chromium so every customer machine renders identical frames.
 */
export async function launchBrowser(): Promise<Browser> {
  const base = { headless: true, args: DETERMINISTIC_ARGS };
  if (process.env.REELFORGE_CHROMIUM) return chromium.launch({ ...base, executablePath: process.env.REELFORGE_CHROMIUM });

  const errors: string[] = [];
  for (const channel of [undefined, "msedge", "chrome"] as const) {
    try {
      return await chromium.launch({ ...base, channel });
    } catch (e) {
      errors.push(`${channel ?? "playwright chromium"}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(`no Chromium-based browser found. Set REELFORGE_CHROMIUM or install Edge/Chrome.\n${errors.join("\n")}`);
}
