import { describe, expect, it } from "vitest";
import {
  classifyResponse,
  findMentions,
  mentionsTarget,
  normalizeHost,
  type DetectionTarget,
} from "@shared/core/detection.ts";

const target: DetectionTarget = {
  business_name: "Northwind Roasters",
  website_url: "https://www.northwindroasters.example/shop",
  business_aliases: ["Northwind Coffee", "NWR"],
  domain_aliases: ["nwr-coffee.example"],
};

const kinds = (text: string, t: DetectionTarget = target) =>
  findMentions(text, t).map((m) => m.kind);

describe("mention detection", () => {
  it("matches the plain name regardless of case", () => {
    const text = "Many people like NORTHWIND ROASTERS for beans.";
    const mentions = findMentions(text, target);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ kind: "name", text: "NORTHWIND ROASTERS" });
    expect(text.slice(mentions[0]!.start, mentions[0]!.end)).toBe("NORTHWIND ROASTERS");
  });

  it("preserves offsets into the raw answer", () => {
    const text = "Intro line.\n\n1. **Northwind Roasters** – small-batch roaster\n2. Other";
    const [mention] = findMentions(text, target);
    expect(text.slice(mention!.start, mention!.end)).toBe("Northwind Roasters");
  });

  it("matches accented and typographically altered spellings", () => {
    const t: DetectionTarget = { business_name: "Café Zoë's Kitchen" };
    expect(mentionsTarget("Try Cafe Zoe's Kitchen downtown.", t)).toBe(true);
    expect(mentionsTarget("Try CAFÉ ZOË’S KITCHEN downtown.", t)).toBe(true);
    const text = "We loved Café Zoë’s Kitchen!";
    const [mention] = findMentions(text, t);
    expect(text.slice(mention!.start, mention!.end)).toBe("Café Zoë’s Kitchen");
  });

  it("treats spaces and hyphens between words as interchangeable", () => {
    expect(mentionsTarget("NorthwindRoasters ships worldwide.", target)).toBe(true);
    expect(mentionsTarget("Northwind-Roasters ships worldwide.", target)).toBe(true);
    expect(mentionsTarget("Northwind Roasters ships worldwide.", target)).toBe(true);
  });

  it("accepts possessives and surrounding punctuation or Markdown", () => {
    expect(mentionsTarget("Northwind Roasters' beans are great.", target)).toBe(true);
    expect(mentionsTarget("(Northwind Roasters)", target)).toBe(true);
    expect(mentionsTarget("**Northwind Roasters**: great", target)).toBe(true);
    expect(mentionsTarget("_Northwind Roasters_", target)).toBe(true);
  });

  it("rejects substring false positives", () => {
    const t: DetectionTarget = { business_name: "Legiit", website_url: "legiit.example" };
    expect(mentionsTarget("That offer seems legiitimate to me.", t)).toBe(false);
    expect(mentionsTarget("Use prelegiit tooling.", t)).toBe(false);
    expect(mentionsTarget("Legiit2 is a different product.", t)).toBe(false);
    expect(mentionsTarget("Try Legiit today.", t)).toBe(true);
    const apple: DetectionTarget = { business_name: "Apple", website_url: "apple.example" };
    expect(mentionsTarget("I love pineapple and Applebee's.", apple)).toBe(false);
    expect(mentionsTarget("See pineapple.example or apple.example.evil.test", apple)).toBe(false);
  });

  it("matches explicit aliases and labels them", () => {
    expect(kinds("Northwind Coffee is solid.")).toEqual(["alias"]);
  });

  it("matches very short names only with exact capitalization", () => {
    expect(kinds("Ask NWR about subscriptions.")).toEqual(["alias"]);
    expect(kinds("The nwr acronym means nothing here.")).toEqual([]);
    const go: DetectionTarget = { business_name: "Go" };
    expect(mentionsTarget("You can go there tomorrow.", go)).toBe(false);
    expect(mentionsTarget("Many teams pick Go for this.", go)).toBe(true);
  });

  it("matches bare domains, URLs, subdomains and Markdown links", () => {
    expect(kinds("Visit northwindroasters.example for details.")).toEqual(["domain"]);
    expect(kinds("See https://www.northwindroasters.example/shop?ref=x.")).toEqual(["domain"]);
    expect(kinds("Order at shop.northwindroasters.example today")).toEqual(["domain"]);
    expect(kinds("[their store](https://northwindroasters.example/beans)")).toEqual(["domain"]);
    expect(kinds("<https://NorthwindRoasters.example>")).toEqual(["domain"]);
    expect(kinds("Also at nwr-coffee.example.")).toEqual(["domain_alias"]);
  });

  it("keeps trailing punctuation out of a domain span", () => {
    const text = "Their site is northwindroasters.example.";
    const [mention] = findMentions(text, target);
    expect(mention!.text).toBe("northwindroasters.example");
  });

  it("rejects look-alike hosts", () => {
    expect(kinds("Try mynorthwindroasters.example instead.")).toEqual([]);
    expect(kinds("Try northwindroasters.example.attacker.test instead.")).toEqual([]);
    expect(kinds("Try northwindroasters-example.test instead.")).toEqual([]);
  });

  it("reports name and link in a Markdown link as separate spans", () => {
    const text = "[Northwind Roasters](https://northwindroasters.example)";
    expect(kinds(text)).toEqual(["name", "domain"]);
  });

  it("returns nothing for empty input or an empty target", () => {
    expect(findMentions("", target)).toEqual([]);
    expect(findMentions("Something", { business_name: "" })).toEqual([]);
  });
});

describe("normalizeHost", () => {
  it("normalizes schemes, www, ports, paths and case", () => {
    expect(normalizeHost("HTTPS://WWW.Example.COM:8443/a/b?c#d")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("user@mail.example.com")).toBe("mail.example.com");
  });
  it("rejects things that are not hosts", () => {
    expect(normalizeHost("localhost")).toBeNull();
    expect(normalizeHost("not a host")).toBeNull();
    expect(normalizeHost("")).toBeNull();
  });
  it("converts internationalized domains to their ASCII form", () => {
    expect(normalizeHost("https://bücher.example")).toBe("xn--bcher-kva.example");
  });
});

describe("inclusion classification", () => {
  it("reports not_mentioned when the target is absent", () => {
    const result = classifyResponse("1. Alpha Beans\n2. Beta Brew\n3. Gamma Roast", target);
    expect(result).toMatchObject({
      mentioned: false,
      inclusion: "not_mentioned",
      rank: null,
      list_position: null,
      matched_spans: [],
    });
  });

  it("reports the explicit rank from a numbered list", () => {
    const text = [
      "Here are some good options:",
      "",
      "1. **Alpha Beans** – wide selection",
      "2. **Beta Brew** – fast shipping",
      "3. **Northwind Roasters** – small-batch, ships weekly",
      "4. **Gamma Roast** – budget friendly",
    ].join("\n");
    const result = classifyResponse(text, target);
    expect(result).toMatchObject({
      mentioned: true,
      inclusion: "included",
      rank: 3,
      list_position: null,
      list_kind: "numbered",
      list_length: 4,
    });
  });

  it("reports list position but no rank for a bullet list", () => {
    const text =
      "Options:\n\n- Alpha Beans\n- Northwind Roasters (northwindroasters.example)\n- Gamma Roast";
    const result = classifyResponse(text, target);
    expect(result).toMatchObject({
      inclusion: "included",
      rank: null,
      list_position: 2,
      list_kind: "bulleted",
      list_length: 3,
    });
    expect(result.matched_spans.map((s) => s.kind)).toEqual(["name", "domain"]);
  });

  it("handles numbered headings with descriptions", () => {
    const text = [
      "## Top picks",
      "",
      "### 1. Alpha Beans",
      "Great selection.",
      "",
      "### 2. Northwind Roasters",
      "Small-batch roaster.",
      "- Ships weekly",
      "",
      "### 3. Gamma Roast",
      "Budget friendly.",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: 2,
      list_length: 3,
    });
  });

  it("handles a bold number wrapping the name", () => {
    const text =
      "**1. Alpha Beans** - big\n**2. Northwind Roasters** - small\n**3. Gamma** - cheap";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "included", rank: 2 });
  });

  it("handles a Markdown link as the item head", () => {
    const text =
      "* [Alpha Beans](https://alpha.example) - big\n* [Northwind Roasters](https://northwindroasters.example) - small";
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      list_position: 2,
      rank: null,
    });
  });

  it("accepts a label before the name", () => {
    const text =
      "- **Best overall:** Alpha Beans\n- **Best for subscriptions:** Northwind Roasters\n- **Budget pick:** Gamma";
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      list_position: 2,
    });
  });

  it("accepts short lead-in words before the name", () => {
    const text = "1. Alpha Beans\n2. Try Northwind Roasters for subscriptions\n3. Gamma";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "included", rank: 2 });
  });

  it("is ambiguous when the target only appears inside another item's description", () => {
    const text =
      "1. **Alpha Beans** – cheaper than Northwind Roasters\n2. **Beta Brew** – fast\n3. **Gamma** – ok";
    const result = classifyResponse(text, target);
    expect(result).toMatchObject({
      mentioned: true,
      inclusion: "ambiguous",
      rank: null,
      list_position: null,
    });
  });

  it("is ambiguous when a list item talks about the target without naming it as the item", () => {
    const text =
      "- Alpha Beans\n- Beta Brew\n- I don't have reliable information about Northwind Roasters";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "ambiguous" });
  });

  it("reports mentioned_only when the target is named outside the list", () => {
    const text = [
      "I couldn't verify Northwind Roasters, so I have not added it.",
      "",
      "1. Alpha Beans",
      "2. Beta Brew",
      "3. Gamma Roast",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({
      mentioned: true,
      inclusion: "mentioned_only",
      rank: null,
      list_position: null,
    });
  });

  it("reports mentioned_only for a closing remark after the list", () => {
    const text =
      "1. Alpha Beans\n2. Beta Brew\n\nLet me know if you want me to look into Northwind Roasters.";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "mentioned_only" });
  });

  it("is ambiguous for prose answers without any list", () => {
    const text =
      "For subscriptions I would look at Northwind Roasters; they roast in small batches.";
    expect(classifyResponse(text, target)).toMatchObject({
      mentioned: true,
      inclusion: "ambiguous",
      list_kind: "none",
    });
  });

  it("prefers inclusion when the target is both discussed and listed", () => {
    const text = [
      "Sure, I've added Northwind Roasters to the list:",
      "",
      "1. Alpha Beans",
      "2. Beta Brew",
      "3. Northwind Roasters",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: 3,
      list_length: 3,
    });
  });

  it("treats unindented bullets between numbered items as part of the numbered item", () => {
    const text = [
      "1. **Alpha Beans**",
      "- Big catalog",
      "- Northwind Roasters partnership announced",
      "2. **Beta Brew**",
      "- Fast",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "ambiguous" });
  });

  it("includes a bare name nested under a category item", () => {
    const text = [
      "1. **Subscription roasters**",
      "   - Alpha Beans",
      "   - Northwind Roasters",
      "2. **Marketplaces**",
      "   - Beta Brew",
      "   - Gamma",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: null,
      list_position: 2,
      list_kind: "bulleted",
    });
  });

  it("reads Markdown tables as unranked lists", () => {
    const text = [
      "| Roaster | Notes |",
      "| --- | --- |",
      "| Alpha Beans | Big |",
      "| Northwind Roasters | Small batch |",
      "| Gamma | Cheap |",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: null,
      list_position: 2,
    });
  });

  it("does not continue a numbered list across a restart", () => {
    const text = "1. Alpha\n2. Beta\n\nRunners-up:\n\n1. Northwind Roasters\n2. Gamma";
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: 1,
      list_length: 2,
    });
  });

  it("uses plain headings as an unranked list when the target is a heading", () => {
    const text =
      "### Alpha Beans\nBig.\n\n### Northwind Roasters\nSmall batch.\n\n### Gamma\nCheap.";
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      rank: null,
      list_position: 2,
    });
  });

  it("never reports a rank for a single-item 'list'", () => {
    const text = "1. Northwind Roasters is one option worth a look.";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "ambiguous", rank: null });
  });

  it("matches by domain alone inside a list item", () => {
    const text = "- alpha.example\n- northwindroasters.example\n- gamma.example";
    expect(classifyResponse(text, target)).toMatchObject({
      inclusion: "included",
      list_position: 2,
    });
  });

  it("ignores list-like lines inside code fences", () => {
    const text = "```\n1. Northwind Roasters\n2. Other\n```\nNothing else.";
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "ambiguous" });
  });
});

// Model answers are full of emoji, and most emoji take two UTF-16 units. Match positions were
// once counted per character on one side and per unit on the other, so everything after an
// emoji was read one position off for each emoji before it.
describe("answers that contain emoji", () => {
  const spanText = (text: string) =>
    classifyResponse(text, target).matched_spans.map((span) => text.slice(span.start, span.end));
  const list = (prefix: string) =>
    [
      "Here are the top picks:" + prefix,
      "",
      "1. **Alpha Beans** – wide selection",
      "2. **Northwind Roasters** – small-batch, ships weekly",
      "3. **Gamma Roast** – budget friendly",
    ].join("\n");

  it("classifies a listed business the same with and without an emoji before it", () => {
    const plain = classifyResponse(list(""), target);
    expect(plain).toMatchObject({ inclusion: "included", rank: 2 });
    for (const emoji of [" 🚀", " 🚀🥇🎯", " 👍🏽", " 👨‍👩‍👧‍👦", " ✅ ⭐"]) {
      const text = list(emoji);
      expect(classifyResponse(text, target)).toMatchObject({ inclusion: "included", rank: 2 });
      expect(spanText(text)).toEqual(["Northwind Roasters"]);
    }
  });

  it("handles an emoji in front of every list item", () => {
    const text = [
      "Top picks:",
      "",
      "1. 🥇 **Alpha Beans** – wide selection",
      "2. 🥈 **Northwind Roasters** – small-batch",
      "3. 🥉 **Gamma Roast** – budget friendly",
    ].join("\n");
    expect(classifyResponse(text, target)).toMatchObject({ inclusion: "included", rank: 2 });
    expect(spanText(text)).toEqual(["Northwind Roasters"]);
    expect(findMentions(text, target)[0]).toMatchObject({ text: "Northwind Roasters" });
  });

  it("never promotes a mention inside another item's description, however many emoji precede it", () => {
    const text = [
      ...Array.from({ length: 11 }, (_, index) => `${index + 1}. 🚀 **Shop ${index + 1}** – fine.`),
      "12. **Alpha Beans** – cheaper than Northwind Roasters",
      "13. **Gamma Roast** – big.",
    ].join("\n");
    const result = classifyResponse(text, target);
    // The business is named, but not as one of the recommended items: it must not be given the
    // rank of the item that happens to follow.
    expect(result.inclusion).not.toBe("included");
    expect(result.rank).toBeNull();
    expect(spanText(text)).toEqual(["Northwind Roasters"]);
  });

  it("keeps offsets exact for accented text and symbols mixed with emoji", () => {
    const text =
      "Café ☕ tips 🎉: try Nörthwind Roasters today 🙌, or northwindroasters.example 🚀.";
    const mentions = findMentions(text, target);
    expect(mentions.map((m) => text.slice(m.start, m.end))).toEqual([
      "Nörthwind Roasters",
      "northwindroasters.example",
    ]);
  });
});
