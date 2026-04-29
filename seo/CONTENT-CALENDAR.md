# content calendar · what to write, in what order

Order of operations matters. Tier-1 keywords are uncontested, so we publish those first to bank cheap wins while the site has zero authority. Tier-2 commercial-intent pages come later when the cluster has built link equity.

## sequencing logic

1. **Weeks 1-4:** ship the dashboard publicly + 4 tier-1 own-it pages. Cheap, fast, owns five keywords outright.
2. **Weeks 5-12:** the remaining tier-1 pages + the technical hub. Build the content cluster's spine.
3. **Weeks 13-24:** tier-2 commercial-intent pages. By now the cluster has internal authority that lifts these pages out of the cold-start hole.
4. **Months 7-12:** quarterly refreshes, "what changed in DataDome's script this quarter" cadence content, comparison pages.

## phase 1, weeks 1-4 (foundation + tier-1 quick wins)

### Week 1
- **Deploy the dashboard** to chosen production URL. Add OG image, sitemap.xml, robots.txt, llms.txt, canonical tag.
- **Submit to Google Search Console + Bing Webmaster + IndexNow.**
- **Write `/about`** (~600 words). Author bio with the credential block (Medium follower count, GitHub repos, TakionAPI mention), photo, what this project is.
- **Write `/faq`** (~30 questions, ~2500 words total).

### Week 2
- **`/datadome/dynamic-challenge`**, first tier-1 page. ~1800 words. Sample expression, walkthrough of how it's computed, link to the extractor in the repo. FAQPage schema with 6 Qs.
- Publish a Twitter thread + LinkedIn post linking to it. (Discovery signal.)

### Week 3
- **`/datadome/boring-challenge`**, ~1500 words. Same structure. FAQPage schema.
- **`/datadome/wasm`**, ~2200 words. Wasm payload anatomy. Show the extracted helpers. Embed a hex-dump preview if helpful. FAQPage schema.

### Week 4
- **`/datadome/vm`**, ~1500 words. State-machine VM walkthrough, switch-case unflattening explained.
- **`/changelog`**, list of npm versions, dates, what changed. Keep it living.
- Audit week: check Google Search Console for crawl errors, Schema markup validator, Lighthouse scores.

**Phase 1 deliverable:** 4 tier-1 pages live + dashboard + about + faq + changelog. Eight indexed pages. Expect to see tier-1 keywords starting to rank top-30 by week 4-5.

## phase 2, weeks 5-12 (cluster spine)

### Week 5
- **`/how-it-works`**, Pillar 1 hub. ~5000 words. This is the keystone page. Sourced from `DEOBFUSCATION.md`, web-formatted, with TOC + jump links + working code blocks. TechArticle schema.

### Week 6
- **`/datadome/`**, cluster hub. Brief description of each child page, with links. CollectionPage schema. ~800 words.
- **`/datadome/deobfuscator`**, the meta page about this tool. ~1800 words. Why it exists, what it does, who it's for. SoftwareApplication schema.

### Week 7
- **`/docs/cli`**, CLI reference. Flag-by-flag, exit codes, the stdout delimiter contract, examples.
- **`/docs/library`**, Node.js library reference. Result shape, options, examples, TypeScript types if you add them.

### Week 8
- **`/docs/api-reference`**, streaming API reference. NDJSON event types, worker thread architecture explanation, integration examples.
- **First republished Medium article on `/blog/`** with canonical pointing to Medium. Pick the highest-traffic DataDome article you've already published.

### Weeks 9-10
- **First original blog post on `/blog/`:** "datadome bundle anatomy: captcha vs interstitial". ~3000 words. Show the byte-level differences, screenshots from the dashboard.

### Weeks 11-12
- **`/datadome/cookies`**, supporting page. ~1500 words. The `datadome` cookie, `datadome-bot` cookie, what they contain, how they're set.
- **`/datadome/detection`**, supporting page. ~1800 words. Signals DataDome checks (canvas, WebGL, fonts, etc.).

**Phase 2 deliverable:** ~16 indexed pages. Cluster has internal cross-linking. Expect tier-1 keywords mostly top-10 by week 10-12.

## phase 3, weeks 13-24 (commercial-intent pages)

This is when we go after the high-volume keywords. Don't start earlier; the cluster needs internal authority first.

### Week 13
- **`/datadome/bypass`**, ~2500 words. Three approaches with pros/cons. Heavy internal linking to /how-it-works and the cluster. Single TakionAPI CTA in the closing third. FAQPage schema with 8 Qs.

### Week 14
- **`/datadome/solver`**, ~2000 words. Comparison-style page listing solver options including TakionAPI as one (neutrally framed, but with the popup elsewhere converting commercial intent). ItemList + FAQPage schema.

### Week 15
- **Begin link-building outreach.** Reach out to scraping/dev community blogs, podcast hosts, Reddit power users in /r/webscraping, /r/learnpython, /r/javascript. Pitch is "I open-sourced a DataDome deobfuscator, want a guest post?"

### Weeks 16-18
- **Original blog post:** "what changed in DataDome's script: Q1 2026". The first quarterly retrospective. ~2500 words. Establishes a recurring content shape that drives refresh traffic.

### Weeks 19-20
- **Comparison pages start.** `/datadome/vs-cloudflare`, `/datadome/vs-akamai`, `/datadome/vs-perimeterx`. Each ~2000 words. These rank for "X vs Y" queries which convert at 4-7%.

### Weeks 21-24
- **Republish more Medium articles** on `/blog/` with canonicals.
- **Optimize existing pages.** Look at Search Console, find pages ranking 11-20, expand them, add internal links.
- **First "DataDome challenge types" deep dive.** ~2500 words. Catalogues all challenge types DataDome serves.

**Phase 3 deliverable:** 25 indexed pages. Tier-2 commercial keywords starting to rank top-30 to top-15. Backlink profile growing.

## phase 4, months 7-12 (authority building)

### Quarterly cadence content
- **"DataDome script changes, Q3 2026"** (October)
- **"DataDome script changes, Q4 2026"** (January)
- Each quarterly post becomes the canonical "what changed" reference. Drives recurring traffic from search + social.

### Original technical articles
- **One per month**, ~2500 words, deep technical content. Topics:
  - "Reverse engineering DataDome's wasm helpers from scratch"
  - "DataDome session lifecycle: cookies, fingerprints, and request signatures"
  - "How DataDome's MBA opaque predicates work (with proof-by-folding)"
  - "DataDome interstitial vs captcha: a side-by-side teardown"
  - "Building a DataDome solver in 2026: realistic timeline + pitfalls"

### Conference / community presence
- Submit talk to a security conference. Same content as the pillar pages, just spoken.
- Cross-post key articles to dev.to, Hashnode, the relevant subreddits.

### Comparison pages refresh
- Update the `/datadome/vs-*` comparison pages quarterly with current pricing/features of competing products.

### Backlink campaigns
- Outreach to: ScrapeOps blog, BotHub, scrapingfish, ScrapeOps newsletter.
- Submit to dev directories: alternativeto.net, BetaList, Product Hunt (when ready), Geek of the Day.
- HackerNews "Show HN: I open-sourced a DataDome deobfuscator". Time it for a slow Tuesday morning.

**Phase 4 deliverable:** 40+ indexed pages. Multiple tier-2 keywords top-10. Tier-1 keywords #1 or top-3. AI Overview citations across the cluster.

## per-page brief template

Use this for every new content page so the writing stays consistent.

```yaml
url: /datadome/<slug>
target_keyword: "<primary>"
secondary_keywords:
  - "<variant 1>"
  - "<variant 2>"
search_intent: informational | commercial | navigational
target_word_count: <number>
schema:
  - TechArticle | FAQPage | etc.
internal_links_in:
  - <page that should link to this one>
internal_links_out:
  - <pages this one links to>
external_links:
  - <authoritative outbound links>
faq_questions:
  - "<real Q1>"
  - "<real Q2>"
  - "<real Q3>"
  - "<real Q4>"
  - "<real Q5>"
  - "<real Q6>"
cta:
  primary: try the dashboard | view on github | read DEOBFUSCATION.md
  commercial: TakionAPI (only on pillar-2 pages)
og_image: <unique image>
last_updated: <date>
author: glizzykingdreko
```

## tone + style guide for content

All content pages follow the README voice (`/Users/glizzykingdreko/Documents/GitHub/datadome-v2-deobfuscator/deobfuscator/README.md`):

- Direct first paragraph, no fluff
- Short paragraphs (2-5 sentences)
- Lowercase headers
- No em dashes anywhere
- Code blocks with real working code (never pseudocode)
- One sardonic aside per major section
- One `:P` per article, no more
- Closing CTA in the last third, never in the intro
- Last-updated date at top of every long-form page

If outsourcing content, brief the writer on the style guide in `~/.claude/skills/glizzykingdreko-voice/references/style-guide.md`. Don't accept content that reads like a marketing agency wrote it.

## measurement

Weekly check (Search Console + Plausible/Umami):

- Indexed pages count
- Top 10 queries driving impressions
- Click-through rate
- Top 10 landing pages
- Average position for each tier-1 + tier-2 keyword

Monthly: write a 1-paragraph "what's working / what's not" note in this repo's `seo/PROGRESS.md` (file to be created at week 4).

Quarterly: update the keyword tier table in `SEO-STRATEGY.md` based on actual rankings, not estimates.
