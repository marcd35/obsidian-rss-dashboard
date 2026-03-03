import { describe, it, expect, vi, beforeEach } from "vitest";
import * as obsidian from "obsidian";

import { AiSummaryService } from "../../src/services/ai-summary-service";
import type { AiSummarySettings, FeedItem } from "../../src/types/types";

const baseSettings: AiSummarySettings = {
  enabled: true,
  provider: "openrouter",
  model: "openai/gpt-5.2",
  apiKey: "test-key",
  localMode: "ollama",
  localBaseUrl: "http://localhost:11434",
  promptTemplate:
    "Title: {{title}}\nFeed: {{feedTitle}}\nURL: {{link}}\nDate: {{pubDate}}\nBody: {{content}}",
  maxInputChars: 200,
  maxOutputTokens: 128,
  timeoutMs: 30000,
  updateCardSummary: false,
};

const article: FeedItem = {
  title: "Unit test article",
  link: "https://example.com/article",
  description: "<p>Hello world body</p>",
  pubDate: "2026-03-01T00:00:00.000Z",
  guid: "unit-1",
  read: false,
  starred: false,
  tags: [],
  feedTitle: "Unit Feed",
  feedUrl: "https://example.com/feed",
  coverImage: "",
};

describe("AiSummaryService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns normalized summary for OpenAI-style providers", async () => {
    const requestUrlMock = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: "Short summary" } }],
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "openrouter",
    });

    const result = await service.summarizeArticle(article);

    expect(result.summary).toBe("Short summary");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe(baseSettings.model);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it("throws when AI is disabled", async () => {
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    const service = new AiSummaryService({
      ...baseSettings,
      enabled: false,
    });

    await expect(service.summarizeArticle(article)).rejects.toThrow(
      "AI summaries are disabled",
    );
    expect(requestUrlSpy).not.toHaveBeenCalled();
  });

  it("throws when API key is missing", async () => {
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    const service = new AiSummaryService({
      ...baseSettings,
      apiKey: "",
    });

    await expect(service.summarizeArticle(article)).rejects.toThrow(
      "Missing API key",
    );
    expect(requestUrlSpy).not.toHaveBeenCalled();
  });

  it("skips API key requirement for local ollama provider", async () => {
    const requestUrlMock = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        response: "Local summary",
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "local",
      apiKey: "",
      localMode: "ollama",
      localBaseUrl: "http://localhost:11434",
      model: "llama3.2",
    });

    const result = await service.summarizeArticle(article);

    expect(result.summary).toBe("Local summary");
    expect(result.provider).toBe("local");

    const callArgs = requestUrlMock.mock.calls[0][0] as { url: string };
    expect(callArgs.url).toBe("http://localhost:11434/api/generate");
  });

  it("uses local OpenAI-compatible endpoint without auth header", async () => {
    const requestUrlMock = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: "Local OAI summary" } }],
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "local",
      apiKey: "",
      localMode: "openai-compatible",
      localBaseUrl: "http://localhost:1234/",
      model: "local-model",
    });

    const result = await service.summarizeArticle(article);

    expect(result.summary).toBe("Local OAI summary");

    const callArgs = requestUrlMock.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(callArgs.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(callArgs.headers.Authorization).toBeUndefined();
  });

  it("throws when local base URL is missing", async () => {
    const requestUrlSpy = vi.spyOn(obsidian, "requestUrl");
    const service = new AiSummaryService({
      ...baseSettings,
      provider: "local",
      apiKey: "",
      localMode: "ollama",
      localBaseUrl: "",
    });

    await expect(service.summarizeArticle(article)).rejects.toThrow(
      "Missing local base URL",
    );
    expect(requestUrlSpy).not.toHaveBeenCalled();
  });

  it("surfaces actionable message when ollama mode gets non-ollama payload", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        message: "Unexpected endpoint or method",
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "local",
      apiKey: "",
      localMode: "ollama",
      localBaseUrl: "http://127.0.0.1:1234",
      model: "google/gemma-3-4b",
    });

    await expect(service.summarizeArticle(article)).rejects.toThrow(
      "switch Local mode to openai-compatible",
    );
  });

  it("uses Claude response parser for claude provider", async () => {
    vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        content: [{ type: "text", text: "Claude summary" }],
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "claude",
      model: "claude-sonnet-4.5",
    });

    const result = await service.summarizeArticle(article);
    expect(result.summary).toBe("Claude summary");
    expect(result.provider).toBe("claude");
  });

  it("truncates long prompt content by configured maxInputChars", async () => {
    const requestUrlMock = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "openai",
      maxInputChars: 10,
    });

    const longArticle: FeedItem = {
      ...article,
      content: "abcdefghijklmnopqrstuvwxyz",
    };

    await service.summarizeArticle(longArticle);

    const callArgs = requestUrlMock.mock.calls[0][0] as { body: string };
    const parsed = JSON.parse(callArgs.body) as {
      messages: Array<{ content: string }>;
    };

    expect(parsed.messages[1].content).toContain("abcdefghij...");
  });

  it("uses prompt template override when provided", async () => {
    const requestUrlMock = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
      status: 200,
      text: JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    } as unknown as Awaited<ReturnType<typeof obsidian.requestUrl>>);

    const service = new AiSummaryService({
      ...baseSettings,
      provider: "openai",
      promptTemplate: "Default template {{title}}",
    });

    await service.summarizeArticle(article, "Override template {{title}}");

    const callArgs = requestUrlMock.mock.calls[0][0] as { body: string };
    const parsed = JSON.parse(callArgs.body) as {
      messages: Array<{ content: string }>;
    };

    expect(parsed.messages[1].content).toContain(
      "Override template Unit test article",
    );
    expect(parsed.messages[1].content).not.toContain("Default template");
  });
});
