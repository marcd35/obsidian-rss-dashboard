import {
  AiSummaryProvider,
  AiSummarySettings,
  DEFAULT_SETTINGS,
} from "../types/types";

export interface ResolvedAiProviderConfig {
  model: string;
  promptTemplate: string;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
}

function normalizeOverrideNumber(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isFinite(value) && (value as number) > 0
    ? (value as number)
    : fallback;
}

export function getResolvedAiProviderConfig(
  settings: AiSummarySettings,
  provider: AiSummaryProvider = settings.provider,
): ResolvedAiProviderConfig {
  const overrides = settings.providerOverrides?.[provider];

  const defaultModel = settings.model || DEFAULT_SETTINGS.aiSummary.model;
  const defaultPrompt =
    settings.promptTemplate || DEFAULT_SETTINGS.aiSummary.promptTemplate;
  const defaultMaxInputChars =
    settings.maxInputChars || DEFAULT_SETTINGS.aiSummary.maxInputChars;
  const defaultMaxOutputTokens =
    settings.maxOutputTokens || DEFAULT_SETTINGS.aiSummary.maxOutputTokens;
  const defaultTimeoutMs =
    settings.timeoutMs || DEFAULT_SETTINGS.aiSummary.timeoutMs;

  const model = overrides?.model?.trim() || defaultModel;
  const promptTemplate = overrides?.promptTemplate || defaultPrompt;

  return {
    model,
    promptTemplate,
    maxInputChars: normalizeOverrideNumber(
      overrides?.maxInputChars,
      defaultMaxInputChars,
    ),
    maxOutputTokens: normalizeOverrideNumber(
      overrides?.maxOutputTokens,
      defaultMaxOutputTokens,
    ),
    timeoutMs: normalizeOverrideNumber(overrides?.timeoutMs, defaultTimeoutMs),
  };
}
