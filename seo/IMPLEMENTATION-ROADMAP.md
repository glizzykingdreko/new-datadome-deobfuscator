# implementation roadmap · technical execution

The build-out, week by week. Tactical, not strategic. The strategy lives in `SEO-STRATEGY.md`; this file is for the actual tickets.

## phase 1 · weeks 1-4 · foundation

Goal: dashboard live publicly, tier-1 keywords starting to rank.

### Week 1, deploy + technical SEO baseline

**Site infrastructure**

- [ ] Pick the production URL. Recommended: `takionapi.tech/tools/datadome-deobfuscator/` (subfolder on main domain). Configure DNS / Vercel project root.
- [ ] `vercel deploy` from the repo. Verify the dashboard loads, drag-and-drop works, NDJSON streaming works on production (cold-start tax noted: first request can be ~1-2s slower).
- [ ] HTTPS auto via Vercel ✓
- [ ] Lighthouse run on `/`. Target: 95+ Performance, 100 Accessibility, 100 Best Practices, 100 SEO.
- [ ] Add `<meta name="description">` to `index.html`: *"Drop a DataDome captcha or interstitial bundle, get clean readable modules. Open-source Babel AST deobfuscator with real-time logs and zip download."*
- [ ] Add OG tags + Twitter Card to `index.html` (see SITE-STRUCTURE.md template).
- [ ] Generate a 1200×630 OG image. Dashboard screenshot, dark background, "datadome deobfuscator" in Doto, GitHub-star count.
- [ ] Add `<link rel="canonical" href="https://takionapi.tech/tools/datadome-deobfuscator/">`.
- [ ] Add `robots.txt` at root: allow all, disallow `/api/`, sitemap reference.
- [ ] Add `sitemap.xml` at root: just `/` for now, will grow.
- [ ] Add `llms.txt` at root with the curated link list.

**Verification + submission**

- [ ] Verify ownership in Google Search Console. Submit sitemap.
- [ ] Verify ownership in Bing Webmaster Tools. Submit sitemap.
- [ ] Configure IndexNow for instant indexing.
- [ ] Set up basic analytics. Use Plausible or Umami (privacy-friendly, no cookie banner needed). Avoid Google Analytics, slows page, scares the audience.

**Schema markup on `/`**

- [ ] Add `SoftwareApplication` schema in JSON-LD.
- [ ] Add `Organization` schema (TakionAPI as owner).
- [ ] Add `Person` schema for glizzykingdreko in the about section.
- [ ] Validate with Google Rich Results Test.

### Week 2, first tier-1 page

- [ ] Set up a content rendering path. Options: keep as plain HTML with simple build script, or migrate to Astro (recommended for content-heavy growth). Plain HTML works fine for ~10 pages; Astro becomes worth it past that.
- [ ] Create `/datadome/dynamic-challenge` page. ~1800 words. See content brief in `CONTENT-CALENDAR.md`.
- [ ] FAQPage schema with 6 real Qs.
- [ ] Author bio block at footer (component reused across all content pages).
- [ ] OG image template. SVG with title text injection, exported per page.
- [ ] Internal link to `/` (deobfuscator dashboard) in the closing third.
- [ ] Update `sitemap.xml`.
- [ ] Push to Search Console for re-crawl.
- [ ] Tweet + LinkedIn post linking to it.

### Week 3, two more tier-1 pages

- [ ] `/datadome/boring-challenge` page (~1500 words).
- [ ] `/datadome/wasm` page (~2200 words).
- [ ] Add 301 redirects: `/datadome/boringChallenge` → `/datadome/boring-challenge`, `/datadome/dynamicChallenge` → `/datadome/dynamic-challenge`. Configure in `vercel.json`.
- [ ] Update `sitemap.xml` and `llms.txt`.
- [ ] Cross-link the three tier-1 pages internally.

### Week 4, fourth tier-1 + ecosystem pages

- [ ] `/datadome/vm` page (~1500 words).
- [ ] `/about` page (~600 words). Author bio with credential block.
- [ ] `/faq` page (~30 questions, ~2500 words). FAQPage schema.
- [ ] `/changelog` page. List every npm version with date and what changed.
- [ ] Audit week:
  - [ ] Run Schema Markup Validator on every page.
  - [ ] Run Lighthouse on every page. Target 95+ everywhere.
  - [ ] Check Search Console for crawl errors, indexing issues, mobile usability problems.
  - [ ] Run a broken-link checker (linkinator or similar).

**Phase 1 exit criteria:**

- ✓ Dashboard + 4 tier-1 pages + about + faq + changelog live
- ✓ All pages have OG tags, canonical, schema markup, mobile responsive
- ✓ Sitemap submitted, Search Console clean
- ✓ At least 1 tier-1 keyword visible in Search Console impressions

## phase 2 · weeks 5-12 · cluster spine

Goal: build the technical authority that lifts tier-2 pages later.

### Week 5

- [ ] `/how-it-works` page. ~5000 words. The keystone. Source from `DEOBFUSCATION.md`, web-format with TOC + jump links + working syntax-highlighted code blocks.
- [ ] TechArticle schema with `articleSection` for each phase.
- [ ] Inline links to all four tier-1 pages with descriptive anchors.

### Week 6

- [ ] `/datadome/` cluster hub (~800 words). Brief one-paragraph descriptions of each child page with links. CollectionPage schema.
- [ ] `/datadome/deobfuscator` page (~1800 words). The meta page about this tool. SoftwareApplication + TechArticle schema.

### Week 7

- [ ] `/docs/cli` page. Flag-by-flag reference. Real example invocations with output.
- [ ] `/docs/library` page. Result shape, options, examples.
- [ ] Add docs hub `/docs/` index page.

### Week 8

- [ ] `/docs/api-reference` page. NDJSON event types, worker thread architecture, integration examples (curl, Python, Node.js fetch).
- [ ] Republish first Medium article to `/blog/<slug>` with `<link rel="canonical" href="medium-url">`. Pick the highest-traffic DataDome article.

### Weeks 9-10

- [ ] First original blog post: "datadome bundle anatomy: captcha vs interstitial". ~3000 words. With dashboard screenshots.
- [ ] Add Article schema with `author`, `datePublished`, `dateModified`.
- [ ] Promote: tweet, LinkedIn, Reddit /r/webscraping (read the rules first).

### Weeks 11-12

- [ ] `/datadome/cookies` (~1500 words).
- [ ] `/datadome/detection` (~1800 words).
- [ ] **Mid-quarter audit:** check rankings for all tier-1 keywords. Anything not top-10 by week 12, expand the page (add 500 words, add 2 more FAQ Qs, build 2 more internal links to it).

**Phase 2 exit criteria:**

- ✓ 16 indexed pages, all with full schema + OG
- ✓ Internal cross-linking complete across the cluster
- ✓ At least 4 tier-1 keywords top-10 in Google
- ✓ First-month organic traffic > 500/mo

## phase 3 · weeks 13-24 · commercial-intent

Goal: rank for the high-volume tier-2 keywords. Now that we have authority.

### Week 13

- [ ] `/datadome/bypass` (~2500 words). Three approaches: solver / stealth / reverse engineer. Heavy internal linking. Single TakionAPI CTA in closing third. FAQPage schema with 8 Qs.

### Week 14

- [ ] `/datadome/solver` (~2000 words). Comparison-style with TakionAPI as one option. ItemList + FAQPage schema.

### Week 15, outreach starts

- [ ] Build a list of 30 target outreach contacts: scraping vendor blogs, dev podcasters, Reddit power users, dev.to authors covering antibot.
- [ ] Send 5 personalized pitches per week. Pitch: guest post / podcast appearance / repo cross-promotion. Use the open-source angle, not the commercial one.

### Weeks 16-18

- [ ] First quarterly retrospective: "what changed in DataDome's script: Q1 2026". ~2500 words. This becomes the recurring content engine.
- [ ] Establish the cadence: every 12 weeks.

### Weeks 19-20, comparison pages

- [ ] `/datadome/vs-cloudflare` (~2000 words). Side-by-side comparison of detection methods, evasion difficulty, cost.
- [ ] `/datadome/vs-akamai` (~2000 words).
- [ ] `/datadome/vs-perimeterx` (~2000 words).
- [ ] Run the [seo-competitor-pages skill](https://docs.claude.com/...) for each one if you want a structured framework.

### Weeks 21-22

- [ ] Republish 2-3 more Medium articles to `/blog/`.
- [ ] Optimize underperformers. Pull from Search Console: any page ranking #11-20. Expand each by 500 words, add 2 FAQ Qs, add 2 inbound internal links.

### Weeks 23-24

- [ ] Comprehensive challenge-types page: "every DataDome challenge variant catalogued" (~2500 words). Useful as a reference, ranks for many longtail queries.
- [ ] **Quarter audit:** rank check for all tier-2 keywords. Submit refreshed sitemap. Run Lighthouse on every page. Build a `seo/PROGRESS.md` log of what's working and what's not.

**Phase 3 exit criteria:**

- ✓ 25 indexed pages
- ✓ All tier-1 keywords top-10, ideally top-3
- ✓ At least 2 tier-2 keywords top-20 (ranking for "datadome bypass" requires sustained effort)
- ✓ 40+ referring domains
- ✓ Organic traffic > 4000/mo

## phase 4 · months 7-12 · authority

Goal: become the default citation for DataDome internals. Optimize for AI Overview / ChatGPT / Perplexity citations.

### Quarterly retrospectives

- [ ] Month 9 (October): "DataDome script changes Q3 2026"
- [ ] Month 12 (January): "DataDome script changes Q4 2026"

These compound. Year-over-year retrospectives become a unique content asset.

### Monthly deep technical articles

One per month. Suggested topics:

- [ ] "Reverse engineering DataDome's wasm helpers from scratch"
- [ ] "DataDome session lifecycle: cookies, fingerprints, and request signatures"
- [ ] "How DataDome's MBA opaque predicates work (with proof-by-folding)"
- [ ] "DataDome interstitial vs captcha: a byte-by-byte teardown"
- [ ] "Building a DataDome solver in 2026: realistic timeline and pitfalls"
- [ ] "DataDome's mobile detection: what changes between web and Android/iOS SDKs"

### Backlinks + community

- [ ] Submit to dev directories: alternativeto.net, BetaList, Product Hunt (when ready), GitHub Marketplace.
- [ ] Show HN post: time it for slow Tuesday morning. Title: "Show HN: I open-sourced a DataDome deobfuscator with real-time logs".
- [ ] Conference talk submissions: BSides, OWASP local chapters, NorthSec, AppSec EU.
- [ ] Newsletter mentions: ScrapeOps newsletter, TheScrapingBee blog, BotHub.
- [ ] Cross-posts: dev.to, Hashnode, the relevant subreddits.

### AI optimization deep dive

By month 9, you should have search-console data showing AI search referrals. Optimize:

- [ ] Find which pages are getting AI Overview citations (Search Console "Performance" → filter for AI crawlers).
- [ ] Strengthen those pages: add more concise direct-answer paragraphs at the top, add more FAQ Qs.
- [ ] Add a `data-* attribute` markup pattern that LLMs like (`data-question="..."`, `data-answer="..."`).
- [ ] Update `llms.txt` quarterly.

### Comparison pages refresh

- [ ] Quarterly update: pricing, features, current state of each competing product.
- [ ] These pages decay faster than evergreen technical content. Schedule a refresh check on the calendar.

**Phase 4 exit criteria:**

- ✓ 40+ indexed pages
- ✓ Multiple tier-2 keywords top-10
- ✓ All tier-1 keywords #1 or top-3
- ✓ 20+ AI Overview citations across the cluster
- ✓ 100+ referring domains
- ✓ Organic traffic > 15,000/mo
- ✓ TakionAPI conversion attribution from organic > 10% of total

## resource requirements

| Resource | Amount | Phase |
|---|---|---|
| Engineer time (you) | ~6 hrs/week | All phases. Bulk in P1, P2. |
| Content writing | Either you or briefed ghostwriter | ~3 hrs/page on tier-1, ~6 hrs/page on tier-2. |
| Design (OG images) | 1 base SVG + per-page text injection | One-time setup. |
| Tooling cost | $0 | Plausible/Umami free tier ok early. Vercel hobby plan ok. |
| Outreach time | ~2 hrs/week from week 15 onward | Phase 3+. |

## dependencies + risks

| Dependency | Risk if broken | Mitigation |
|---|---|---|
| takionapi.tech available for subfolder hosting | If unavailable, fall back to dedicated domain. Loses link-equity sharing. | Negotiate hosting access early. |
| DataDome script remains stable | If they ship a major rewrite, deobfuscator breaks, content goes stale fast | Public changelog + reference-input regression tests. Quarterly content updates. |
| Google doesn't deindex for "anti-bot bypass" terms | Rare but possible | Frame all content as "research / case study". Outbound CTA, not on-page sale. Safe pattern. |
| AI search engines keep crawling | If they start blocking small sites or paywalling | Multi-channel: classic SEO + AI search + GitHub + npm + Medium. No single-channel dependency. |

## quick wins to ship in week 1

If you only have one afternoon, do these:

1. Add `<meta name="description">` and OG tags to `index.html`. (15 min)
2. Add canonical tag to `index.html`. (5 min)
3. Create `robots.txt`, `sitemap.xml`, `llms.txt`. (20 min)
4. Add SoftwareApplication + Organization JSON-LD schema to `index.html`. (30 min)
5. Submit to Google Search Console + Bing Webmaster + IndexNow. (15 min)
6. Generate one OG image. (30 min)

That's ~2 hours of work and gets the dashboard SEO-ready before any content exists.
