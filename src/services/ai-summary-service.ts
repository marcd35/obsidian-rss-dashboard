import { requestUrl } from "obsidian";
import {
  AiSummaryProvider,
  AiSummarySettings,
  FeedItem,
} from "../types/types";

export interface AiSummaryResult {
  summary: string;
  provider: AiSummaryProvider;
  model: string;
}

// Service boundary for all AI summarization calls.
//
// Design intent:
// - Keep UI layers provider-agnostic.
// - Normalize success/error behavior regardless of upstream API shape.
// - Keep prompt construction centralized so prompt changes do not require UI edits.
export class AiSummaryService {
  constructor(private settings: AiSummarySettings) {}

  private isLocalProvider(): boolean {
    return this.settings.provider === "local";
  }

  public async summarizeArticle(
    article: FeedItem,
    promptTemplateOverride?: string,
  ): Promise<AiSummaryResult> {
    if (!this.settings.enabled) {
      throw new Error("AI summaries are disabled in settings.");
    }

    const apiKey = this.settings.apiKey?.trim();
    if (!this.isLocalProvider() && !apiKey) {
      throw new Error("Missing API key. Configure it in AI settings.");
    }

    const prompt = this.buildPrompt(article, promptTemplateOverride);

    switch (this.settings.provider) {
      case "openrouter": {
        // OpenRouter exposes an OpenAI-compatible chat completions surface.
        return this.requestOpenAiStyle(
          "https://openrouter.ai/api/v1/chat/completions",
          apiKey,
          prompt,
          {
            "HTTP-Referer": "obsidian://rss-dashboard",
            "X-OpenRouter-Title": "RSS Dashboard",
          },
        );
      }
      case "openai": {
        // Direct OpenAI chat completions path (kept for MVP compatibility).
        return this.requestOpenAiStyle(
          "https://api.openai.com/v1/chat/completions",
          apiKey,
          prompt,
        );
      }
      case "kilo": {
        // Temporarily disabled until Kilo integration hardening is completed.
        throw new Error(
          "Kilo provider is temporarily disabled. Select OpenRouter, OpenAI, or Claude.",
        );
      }
      case "claude": {
        // Anthropic uses a different request/response schema than chat completions.
        return this.requestClaudeStyle(apiKey, prompt);
      }
      case "local": {
        return this.requestLocalStyle(prompt);
      }
      default:
        throw new Error("Unsupported AI provider configured.");
    }
  }

  public async testConnection(): Promise<void> {
    const testArticle: FeedItem = {
      title: "Connection test",
      link: "https://example.com",
      description: "This is a short test article.",
      pubDate: new Date().toISOString(),
      guid: "ai-test",
      read: false,
      starred: false,
      tags: [],
      feedTitle: "System",
      feedUrl: "https://example.com/feed",
      coverImage: "",
    };

    await this.summarizeArticle(testArticle);
  }

  private async requestOpenAiStyle(
    endpoint: string,
    apiKey: string | null,
    prompt: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<AiSummaryResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      throw: false,
      headers,
      body: JSON.stringify({
        model: this.settings.model,
        messages: [
          {
            role: "system",
            content:
              "You summarize RSS articles. Keep output concise, factual, and easy to skim.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        max_tokens: this.settings.maxOutputTokens,
        temperature: 0.2,
      }),
    });

    if (response.status >= 400) {
      throw new Error(`Provider request failed (${response.status}).`);
    }

    const payload = JSON.parse(response.text) as {
      choices?: Array<{
        message?: {
          content?: string | null;
        };
      }>;
    };

    const summary = payload.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      throw new Error("Provider returned an empty summary.");
    }

    return {
      summary,
      provider: this.settings.provider,
      model: this.settings.model,
    };
  }

  private async requestLocalStyle(prompt: string): Promise<AiSummaryResult> {
    const baseUrl = this.settings.localBaseUrl?.trim();
    if (!baseUrl) {
      throw new Error("Missing local base URL. Configure it in AI settings.");
    }

    if (this.settings.localMode === "openai-compatible") {
      const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
      return this.requestOpenAiStyle(endpoint, null, prompt);
    }

    if (this.settings.localMode !== "ollama") {
      throw new Error("Unsupported local model mode configured.");
    }

    const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/generate`;
    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      throw: false,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.model,
        prompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: this.settings.maxOutputTokens,
        },
      }),
    });

    if (response.status >= 400) {
      throw new Error(`Provider request failed (${response.status}).`);
    }

    const payload = JSON.parse(response.text) as {
      response?: string;
    };

    const summary = payload.response?.trim();
    if (!summary) {
      throw new Error(
        "Local provider returned no summary in Ollama format. If you are using LM Studio or another OpenAI-compatible server, switch Local mode to openai-compatible.",
      );
    }

    return {
      summary,
      provider: this.settings.provider,
      model: this.settings.model,
    };
  }

  private async requestClaudeStyle(
    apiKey: string,
    prompt: string,
  ): Promise<AiSummaryResult> {
    const response = await requestUrl({
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      throw: false,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.settings.model,
        max_tokens: this.settings.maxOutputTokens,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (response.status >= 400) {
      throw new Error(`Provider request failed (${response.status}).`);
    }

    const payload = JSON.parse(response.text) as {
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    };

    const summary = payload.content
      ?.find((part) => part.type === "text")
      ?.text?.trim();

    if (!summary) {
      throw new Error("Provider returned an empty summary.");
    }

    return {
      summary,
      provider: this.settings.provider,
      model: this.settings.model,
    };
  }

  private buildPrompt(
    article: FeedItem,
    promptTemplateOverride?: string,
  ): string {
    // Prompt template placeholders are intentionally simple string replacements.
    // Keep placeholders aligned with settings-tab description text.
    const content = this.getPromptContent(article);
    const template = promptTemplateOverride ?? this.settings.promptTemplate;
    return template
      .replace("{{title}}", article.title || "")
      .replace("{{feedTitle}}", article.feedTitle || "")
      .replace("{{link}}", article.link || "")
      .replace("{{pubDate}}", article.pubDate || "")
      .replace("{{content}}", content);
  }

  private getPromptContent(article: FeedItem): string {
    // Prefer richer content first, then fallback to existing summaries/description.
    // This keeps the feature resilient when full-content extraction is unavailable.
    const raw =
      article.content ||
      article.aiSummaryText ||
      article.summary ||
      article.description ||
      "";
    const stripped = raw
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length <= this.settings.maxInputChars) {
      return stripped;
    }
    return `${stripped.slice(0, this.settings.maxInputChars)}...`;
  }
}
