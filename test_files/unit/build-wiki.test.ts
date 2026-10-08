import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWiki, stripFrontMatter } from "../../scripts/build-wiki.mjs";

const REPO = "https://github.com/amatya-aditya/obsidian-rss-dashboard";

describe("build-wiki", () => {
  let root: string;
  let out: string;

  function write(rel: string, content: string | Uint8Array): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  function build(): string[] {
    return buildWiki({
      sourceDir: path.join(root, "docs/wiki"),
      outDir: out,
      repoRoot: root,
    });
  }

  function read(name: string): string {
    return fs.readFileSync(path.join(out, name), "utf8");
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "build-wiki-"));
    out = path.join(root, ".wiki-build");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("strips YAML front matter and leaves other rules alone", () => {
    expect(stripFrontMatter("---\ntype: x\nsince: 1\n---\n\n# Title\n")).toBe(
      "# Title\n",
    );
    expect(stripFrontMatter("# No front matter\n\n---\n\ntext")).toBe(
      "# No front matter\n\n---\n\ntext",
    );
    write("docs/wiki/Page.md", "---\ntype: ref\n---\n# Page\n");
    build();
    expect(read("Page.md")).not.toContain("type: ref");
    expect(read("Page.md")).toContain("# Page");
  });

  it("flattens pages to their base names", () => {
    write("docs/wiki/a/First.md", "# First\n");
    write("docs/wiki/b/c/Second.md", "# Second\n");

    expect(build().sort()).toEqual(["First", "Second"]);
    expect(fs.existsSync(path.join(out, "First.md"))).toBe(true);
    expect(fs.existsSync(path.join(out, "Second.md"))).toBe(true);
  });

  it("fails on duplicate page base names", () => {
    write("docs/wiki/a/Same.md", "# A\n");
    write("docs/wiki/b/Same.md", "# B\n");

    expect(() => build()).toThrow(/Duplicate page name "Same"/);
  });

  it("rewrites links between pages and keeps anchors", () => {
    write("docs/wiki/a/First.md", "[go](../b/Second.md#part)\n");
    write("docs/wiki/b/Second.md", "# Second\n");
    build();

    expect(read("First.md")).toContain("[go](Second#part)");
  });

  it("rewrites links to repo files outside the source folder", () => {
    write("CHANGELOG.md", "# log\n");
    write("docs/wiki/a/First.md", "[log](../../../CHANGELOG.md#x)\n");
    build();

    expect(read("First.md")).toContain(
      `[log](${REPO}/blob/master/CHANGELOG.md#x)`,
    );
  });

  it("fails on links that point at nothing", () => {
    write("docs/wiki/First.md", "[gone](Missing.md)\n");
    expect(() => build()).toThrow(/Broken link/);

    write("docs/wiki/First.md", "[gone](../../NOPE.md)\n");
    expect(() => build()).toThrow(/does not exist/);
  });

  it("leaves URLs, anchors and links inside code alone", () => {
    write(
      "docs/wiki/First.md",
      "[web](https://example.com/a.md) [top](#top)\n\n`[x](nope.md)`\n\n```\n[y](nope.md)\n```\n",
    );
    build();

    const page = read("First.md");
    expect(page).toContain("[web](https://example.com/a.md)");
    expect(page).toContain("[top](#top)");
    expect(page).toContain("`[x](nope.md)`");
    expect(page).toContain("[y](nope.md)");
  });

  it("copies images to a flat images folder and rewrites their paths", () => {
    write("docs/wiki/img/logo.png", new Uint8Array([1, 2, 3]));
    write("docs/wiki/a/First.md", "![logo](../img/logo.png)\n");
    build();

    expect(read("First.md")).toContain("![logo](images/logo.png)");
    expect(fs.existsSync(path.join(out, "images", "logo.png"))).toBe(true);
  });

  it("fails on image name clashes", () => {
    write("docs/wiki/a/logo.png", new Uint8Array([1]));
    write("docs/wiki/b/logo.png", new Uint8Array([2]));

    expect(() => build()).toThrow(/Duplicate image name "logo.png"/);
  });

  it("appends a per-page Edit link but not to the sidebar or footer", () => {
    write("docs/wiki/a/First.md", "# First\n");
    write("docs/wiki/_Sidebar.md", "[First](a/First.md)\n");
    write("docs/wiki/_Footer.md", "[Report](https://example.com)\n");
    build();

    expect(read("First.md")).toContain(
      `[Edit this page](${REPO}/edit/master/docs/wiki/a/First.md)`,
    );
    expect(read("_Sidebar.md")).not.toContain("Edit this page");
    expect(read("_Footer.md")).not.toContain("Edit this page");
  });

  it("copies the sidebar and footer with their links rewritten", () => {
    write("docs/wiki/a/First.md", "# First\n");
    write("docs/wiki/_Sidebar.md", "- [First](a/First.md)\n");
    write("docs/wiki/_Footer.md", "[First](a/First.md)\n");
    build();

    expect(read("_Sidebar.md")).toContain("[First](First)");
    expect(read("_Footer.md")).toContain("[First](First)");
  });
});
