import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as obsidian from "obsidian";
import {
  EMPTY_FEED_ERROR_MESSAGE,
  EmptyFeedError,
  FeedParser,
  formatFeedParseNoticeMessage,
  getFeedErrorMessage,
  loadFeedForPreview,
} from "../../src/services/feed-parser";
import { DEFAULT_SETTINGS } from "../../src/types/types";

const EMPTY_RSS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Recent changes on Vivaldi Translations</title>
    <link>https://translations.vivaldi.com/</link>
    <description>All recent changes made using Weblate on Vivaldi Translations.</description>
    <atom:link href="https://translations.vivaldi.com/exports/rss/" rel="self"/>
    <language>en</language>
    <lastBuildDate>Fri, 06 Mar 2026 15:58:34 +0000</lastBuildDate>
  </channel>
</rss>`;

const NORMAL_RSS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <description>Example description</description>
    <item>
      <title>Post 1</title>
      <link>https://example.com/posts/1</link>
      <description>Hello world</description>
      <pubDate>Fri, 06 Mar 2026 15:58:34 +0000</pubDate>
      <guid>https://example.com/posts/1</guid>
    </item>
  </channel>
</rss>`;

type FakeSelectorMap = Record<string, string | null | undefined>;

class FakeXmlElement {
  constructor(
    private readonly values: FakeSelectorMap,
    private readonly attributes: Record<string, string> = {},
  ) {}

  querySelector(selector: string): FakeXmlElement | null {
    const normalizedSelector = selector.trim();
    const value = this.values[normalizedSelector];
    if (value === undefined || value === null) {
      return null;
    }

    return new FakeXmlElement({}, { textContent: value, href: value });
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  get textContent(): string {
    return this.attributes.textContent || "";
  }
}

class FakePreviewDocument {
  constructor(private readonly channel: FakeXmlElement | null) {}

  querySelector(selector: string): FakeXmlElement | null {
    if (selector === "channel") {
      return this.channel;
    }

    if (selector === "feed" || selector === "item, entry") {
      return null;
    }

    return null;
  }
}

function mockRequest(text: string): void {
  vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
    status: 200,
    text,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json: {},
  } as Awaited<ReturnType<typeof obsidian.requestUrl>>);
}

describe("empty feed validation", () => {
  const originalDomParser = globalThis.DOMParser;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDomParser) {
      globalThis.DOMParser = originalDomParser;
    } else {
      delete (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    }
  });

  it("throws a dedicated empty-feed error for valid feeds with no parsed entries", async () => {
    mockRequest(EMPTY_RSS_XML);

    const parser = new FeedParser(DEFAULT_SETTINGS.media, []);
    (parser as unknown as { parser: { parseString: (xml: string) => unknown } }).parser =
      {
      parseString: vi.fn().mockReturnValue({
        title: "Recent changes on Vivaldi Translations",
        description: "All recent changes made using Weblate on Vivaldi Translations.",
        link: "https://translations.vivaldi.com/",
        author: "",
        image: undefined,
        items: [],
        type: "rss",
        feedItunesImage: "",
        feedImageUrl: "",
      }),
    };

    await expect(
      parser.parseFeed("https://translations.vivaldi.com/exports/rss/"),
    ).rejects.toEqual(new EmptyFeedError());
  });

  it("allows an empty valid feed when the caller explicitly opts in", async () => {
    mockRequest(EMPTY_RSS_XML);

    const parser = new FeedParser(DEFAULT_SETTINGS.media, []);
    (parser as unknown as { parser: { parseString: (xml: string) => unknown } }).parser =
      {
        parseString: vi.fn().mockReturnValue({
          title: "Recent changes on Vivaldi Translations",
          description:
            "All recent changes made using Weblate on Vivaldi Translations.",
          link: "https://translations.vivaldi.com/",
          author: "",
          image: undefined,
          items: [],
          type: "rss",
          feedItunesImage: "",
          feedImageUrl: "",
        }),
      };

    const parsedFeed = await parser.parseFeed(
      "https://translations.vivaldi.com/exports/rss/",
      null,
      { allowEmpty: true },
    );

    expect(parsedFeed.title).toBe("Recent changes on Vivaldi Translations");
    expect(parsedFeed.items).toHaveLength(0);
  });

  it("keeps normal feed parsing unchanged when at least one item exists", async () => {
    mockRequest(NORMAL_RSS_XML);

    const parser = new FeedParser(DEFAULT_SETTINGS.media, []);
    (parser as unknown as { parser: { parseString: (xml: string) => unknown } }).parser =
      {
      parseString: vi.fn().mockReturnValue({
        title: "Example Feed",
        description: "Example description",
        link: "https://example.com/",
        author: "",
        image: undefined,
        items: [
          {
            title: "Post 1",
            link: "https://example.com/posts/1",
            description: "Hello world",
            pubDate: "Fri, 06 Mar 2026 15:58:34 +0000",
            guid: "https://example.com/posts/1",
            author: "",
            content: "Hello world",
          },
        ],
        type: "rss",
        feedItunesImage: "",
        feedImageUrl: "",
      }),
    };

    const parsedFeed = await parser.parseFeed("https://example.com/feed.xml");

    expect(parsedFeed.title).toBe("Example Feed");
    expect(parsedFeed.items).toHaveLength(1);
    expect(parsedFeed.items[0].guid).toBe("https://example.com/posts/1");
  });

  it("preserves invalid-feed failures as non-empty-feed errors", async () => {
    mockRequest("<html>no feed here</html>");

    const parser = new FeedParser(DEFAULT_SETTINGS.media, []);
    (parser as unknown as { parser: { parseString: (xml: string) => unknown } }).parser =
      {
      parseString: vi.fn().mockImplementation(() => {
        throw new Error("Not a valid RSS/Atom feed");
      }),
    };

    await expect(
      parser.parseFeed("https://example.com/not-a-feed"),
    ).rejects.not.toMatchObject({
      name: "EmptyFeedError",
      message: EMPTY_FEED_ERROR_MESSAGE,
    });
  });

  it("formats add/import messaging explicitly for empty feeds", () => {
    expect(formatFeedParseNoticeMessage(new EmptyFeedError())).toBe(
      EMPTY_FEED_ERROR_MESSAGE,
    );
    expect(getFeedErrorMessage(new EmptyFeedError())).toBe(
      EMPTY_FEED_ERROR_MESSAGE,
    );
    expect(formatFeedParseNoticeMessage(new Error("boom"))).toBe(
      "Error parsing feed: boom",
    );
    expect(getFeedErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("loads preview metadata for an empty but valid feed without treating it as an error", async () => {
    mockRequest(EMPTY_RSS_XML);

    globalThis.DOMParser = class {
      parseFromString(): FakePreviewDocument {
        return new FakePreviewDocument(
          new FakeXmlElement({
            title: "Recent changes on Vivaldi Translations",
            description:
              "All recent changes made using Weblate on Vivaldi Translations.",
            link: "https://translations.vivaldi.com/",
            "image > url, itunes\\:image": null,
            "itunes\\:image": null,
          }),
        );
      }
    } as unknown as typeof DOMParser;

    await expect(
      loadFeedForPreview("https://translations.vivaldi.com/exports/rss/"),
    ).resolves.toEqual({
      title: "Recent changes on Vivaldi Translations",
      description:
        "All recent changes made using Weblate on Vivaldi Translations.",
      link: "https://translations.vivaldi.com/",
      image: "",
      latestPubDate: "",
      hasEntries: false,
      feedUrl: "https://translations.vivaldi.com/exports/rss/",
    });
  });
});
