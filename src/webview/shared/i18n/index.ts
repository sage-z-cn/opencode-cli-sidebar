import { getBridge } from "../bridge";
import { setStrings } from "./core";

interface L10nBundle {
  strings: Record<string, string>;
}

/** Attempts before giving up on the bundle. */
const MAX_ATTEMPTS = 5;
/** Delay between attempts; long enough to outlast webview listener setup. */
const RETRY_DELAY_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the l10n bundle before the first render so components never paint
 * English source strings under a non-English locale.
 *
 * Retries because the first message a webview posts can be dropped: the host
 * attaches its message listener while the webview script is already running,
 * so a single request is a race. Everything degrades to English source strings
 * when every attempt fails, so this can delay the UI but never block it.
 */
export async function initI18n(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const bundle = await getBridge().request<L10nBundle>(
        "getL10nBundle",
        {},
        { timeout: 3000 },
      );
      const strings = bundle?.strings ?? {};
      if (Object.keys(strings).length > 0) {
        setStrings(strings);
        return;
      }
      // An empty dictionary means the host answered before it could resolve a
      // bundle file; retrying is cheaper than shipping an untranslated UI.
      console.warn(
        `[i18n] bundle request returned no strings (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
    } catch (error) {
      console.warn(
        `[i18n] bundle request failed (attempt ${attempt}/${MAX_ATTEMPTS})`,
        error,
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await delay(RETRY_DELAY_MS);
    }
  }

  console.warn("[i18n] falling back to English source strings");
  setStrings({});
}
