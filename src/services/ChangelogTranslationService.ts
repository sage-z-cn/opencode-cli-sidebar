import { OutputChannelService } from "./OutputChannelService";
import {
  OpenCodeGenerateClient,
  OpenCodeGenerateError,
  type OpenCodeGenerateConnection,
  type OpenCodeGenerateFailure,
} from "./OpenCodeGenerateClient";
import type { ChangelogTextBlock } from "../types";

/** Failure classes mapped to short user-facing reasons by the provider. */
export type ChangelogTranslationFailure =
  | "no-connection"
  | "aborted"
  | "rate-limit"
  | "timeout"
  | "service-unavailable"
  | "unreachable"
  | "invalid-response"
  | "empty-response"
  | "http"
  | "unknown";

export class ChangelogTranslationError extends Error {
  public constructor(
    public readonly failure: ChangelogTranslationFailure,
    message: string,
    public readonly status?: number,
    public readonly providerID?: string,
    public readonly model?: string,
  ) {
    super(message);
    this.name = "ChangelogTranslationError";
  }
}

/** Minimal Memento-shaped persistence for translation results. */
export interface ChangelogTranslationStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ChangelogTranslationRequest {
  version: string;
  htmlHash: string;
  targetLanguage: string;
  blocks: ChangelogTextBlock[];
}

const CACHE_KEY_PREFIX = "opencodeChangelogTranslation.";
/** Character budget for one model request; oversized blocks are sent alone. */
const MAX_BATCH_CHARS = 6000;
const LOG_PREFIX = "[ChangelogTranslation]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapGenerateFailure(
  failure: OpenCodeGenerateFailure,
): ChangelogTranslationFailure {
  switch (failure) {
    case "aborted":
      return "aborted";
    case "unreachable":
      return "unreachable";
    case "not-ready":
      return "service-unavailable";
    case "rate-limit":
      return "rate-limit";
    case "timeout":
      return "timeout";
    case "http":
      return "http";
    case "empty":
      return "empty-response";
    case "invalid":
      return "invalid-response";
  }
}

/** Splits blocks into batches whose combined text stays within the budget. */
function buildBatches(blocks: ChangelogTextBlock[]): ChangelogTextBlock[][] {
  const batches: ChangelogTextBlock[][] = [];
  let current: ChangelogTextBlock[] = [];
  let currentChars = 0;

  for (const block of blocks) {
    const length = block.text.length;
    if (current.length > 0 && currentChars + length > MAX_BATCH_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(block);
    currentChars += length;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function buildPrompt(
  blocks: ChangelogTextBlock[],
  targetLanguage: string,
): string {
  return [
    `Translate every value of the JSON object below into the language identified by BCP 47 tag "${targetLanguage}".`,
    "Return only a pure JSON object, without markdown fences or commentary. Its keys must exactly match the input ids and it must contain one value per id.",
    "Keep every \u27E6n\u27E7 placeholder exactly as it appears, including its number and brackets. Do not renumber, merge, split, or remove placeholders.",
    "Do not translate product names and technical terms: OpenCode, TUI, Desktop, SDK, MCP, API, CLI, Bun, GitHub, Windows, macOS, Linux, npm, pnpm, Homebrew, JSON, YAML, PTY, SSE, OAuth, URL, Git, worktree, plugin, skill, agent, provider, model, session, terminal, diff, patch, commit, experimental.",
    "Keep code, commands, file paths, version numbers, and issue numbers exactly as written.",
    "Do not merge or split entries.",
    `Input:\n${JSON.stringify(blocks, null, 2)}`,
  ].join("\n");
}

/**
 * Parses a model reply into translations for the requested ids. Returns
 * undefined when the reply carries no JSON object at all; entries that are not
 * non-empty strings are dropped so the caller can retry or fall back.
 */
function parseTranslationResponse(
  text: string,
  ids: readonly string[],
): Record<string, string> | undefined {
  const unfenced = text.replace(/```json/gi, "").replace(/```/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const translations: Record<string, string> = {};
  for (const id of ids) {
    const value = parsed[id];
    if (typeof value === "string" && value.trim()) {
      translations[id] = value;
    }
  }
  return translations;
}

/**
 * Translates changelog text blocks through the local OpenCode server and
 * caches the result per language, version, and HTML hash. One batch is sent
 * at a time so a failure aborts the whole translation, which the caller turns
 * into a single failed reply.
 */
export class ChangelogTranslationService {
  private readonly store: ChangelogTranslationStore;
  private readonly resolveConnection: () => OpenCodeGenerateConnection | undefined;
  private readonly logger: OutputChannelService;

  public constructor(
    store: ChangelogTranslationStore,
    resolveConnection: () => OpenCodeGenerateConnection | undefined,
    logger?: OutputChannelService,
  ) {
    this.store = store;
    this.resolveConnection = resolveConnection;
    this.logger = logger ?? OutputChannelService.getInstance();
  }

  public async translate(
    request: ChangelogTranslationRequest,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const cacheKey = this.cacheKey(request);
    const cached = this.store.get<Record<string, string>>(cacheKey);
    if (cached && typeof cached === "object") {
      this.logger.debug(`${LOG_PREFIX} cache hit for ${cacheKey}`);
      return { ...cached };
    }

    const connection = this.resolveConnection();
    if (!connection) {
      throw new ChangelogTranslationError(
        "no-connection",
        "OpenCode connection is unavailable",
      );
    }

    const client = new OpenCodeGenerateClient(connection, this.logger);
    const batches = buildBatches(request.blocks);
    const translations: Record<string, string> = {};

    try {
      for (const batch of batches) {
        Object.assign(
          translations,
          await this.translateBatch(client, request, batch, signal),
        );
      }
    } catch (error) {
      this.logger.debug(
        `${LOG_PREFIX} translation failed for ${request.version} (${request.targetLanguage}): ${errorMessage(error)}`,
      );
      if (error instanceof ChangelogTranslationError) {
        throw error;
      }
      if (error instanceof OpenCodeGenerateError) {
        const model =
          error.failure === "rate-limit"
            ? await client.getDefaultModel()
            : undefined;
        throw new ChangelogTranslationError(
          mapGenerateFailure(error.failure),
          error.message,
          error.status,
          error.providerID,
          model,
        );
      }
      throw new ChangelogTranslationError("unknown", errorMessage(error));
    }

    try {
      await this.store.update(cacheKey, translations);
      this.logger.debug(
        `${LOG_PREFIX} cached ${Object.keys(translations).length} block(s) for ${cacheKey}`,
      );
    } catch (error) {
      // A cache write failure must not turn a successful translation into
      // a user-visible failure.
      this.logger.debug(
        `${LOG_PREFIX} failed to cache ${cacheKey}: ${errorMessage(error)}`,
      );
    }
    return translations;
  }

  private cacheKey(request: ChangelogTranslationRequest): string {
    return `${CACHE_KEY_PREFIX}${request.targetLanguage}.${request.version}.${request.htmlHash}`;
  }

  /**
   * Translates one batch. A reply without valid JSON, or without every id, is
   * retried once. A still-incomplete batch falls back to the source text so
   * the returned map always covers the whole batch; a reply that never parses
   * throws instead.
   */
  private async translateBatch(
    client: OpenCodeGenerateClient,
    request: ChangelogTranslationRequest,
    batch: ChangelogTextBlock[],
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    const ids = batch.map((block) => block.id);

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await client.generate(
        buildPrompt(batch, request.targetLanguage),
        signal,
      );
      const parsed = parseTranslationResponse(response, ids);

      if (parsed) {
        const missing = batch.filter((block) => !(block.id in parsed));
        if (missing.length === 0) {
          return parsed;
        }
        if (attempt === 1) {
          this.logger.debug(
            `${LOG_PREFIX} batch still missing ${missing.length} id(s); keeping source text`,
          );
          for (const block of missing) {
            parsed[block.id] = block.text;
          }
          return parsed;
        }
        this.logger.debug(
          `${LOG_PREFIX} batch missing ${missing.length} id(s); retrying once`,
        );
        continue;
      }

      if (attempt === 1) {
        throw new ChangelogTranslationError(
          "invalid-response",
          "model response did not contain a valid JSON object",
        );
      }
      this.logger.debug(
        `${LOG_PREFIX} batch response was not valid JSON; retrying once`,
      );
    }

    throw new ChangelogTranslationError(
      "unknown",
      "translation batch ended without a result",
    );
  }
}
