# datadome-deobfuscator · SEO strategy

Master plan to make this the canonical destination for anyone searching DataDome internals: bypass / solver / deobfuscator / dynamic_challenge / boring_challenge / wasm / VM.

## tl;dr

- Pick a permanent URL on `takionapi.tech` (subfolder, not subdomain) so SEO equity stacks with the commercial product.
- Single-page tool stays at `/`. Build a `/datadome/*` content cluster around the niche keywords. Each keyword gets its own page, each page is owned outright because nobody else writes about `boring_challenge` or `dynamic_challenge`.
- E-E-A-T is the moat: tied to the open-source repo, glizzykingdreko's Medium history, and TakionAPI as the commercial backer. Lean on that hard.
- Optimize for **AI search** (Google AI Overviews, ChatGPT, Perplexity) as much as classic Google. The audience searches via LLMs, and LLMs cite well-structured technical pages with clear Q&A blocks.

## audience

| segment | what they search | intent |
|---|---|---|
| Bot developers / scrapers | `datadome bypass`, `datadome solver`, `datadome captcha bypass` | Commercial. Looking to buy or build. |
| Security researchers | `datadome reverse engineering`, `datadome wasm`, `datadome dynamic_challenge` | Informational. Looking to understand. |
| Reverse engineers | `datadome deobfuscator`, `datadome boring_challenge`, `datadome obfuscation` | Informational + tool. Looking for prior art. |
| Bug-bounty / red-team | `datadome boringChallenge`, `datadome VM`, `datadome anti-bot` | Informational + sometimes commercial. |

The first segment converts to TakionAPI (commercial). The other three convert to GitHub stars, npm installs, Medium follows, all of which feed back into authority signals.

## positioning

> The open-source companion to TakionAPI's DataDome solving API.

This is the single positioning line. Two things follow from it:

1. The dashboard / repo / npm package are the **proof-of-work**. They demonstrate end-to-end DataDome internals understanding.
2. TakionAPI is the **escape hatch**. The dashboard's bottom-right popup ("// or skip the hard part · TakionAPI · DataDome solver") routes intent-ready visitors to revenue.

Don't soft-sell. Every page should answer the technical question first, then surface TakionAPI in the closing third with one well-placed CTA.

## target keywords

Tiered by competition. All numbers are rough estimates; validate with DataForSEO once a Google Search Console history exists.

### tier 1, uncontested longtail (own these immediately)

These are technical terms barely targeted by anyone. One well-structured page each → top-3 in 4-8 weeks.

| keyword | page | rough monthly volume | why uncontested |
|---|---|---|---|
| `datadome dynamic_challenge` | /datadome/dynamic-challenge | 50-200 | Internal DD term, almost no SEO content. |
| `datadome dynamicChallenge` | redirect → above | 30-100 | Same term, camelCase variant. |
| `datadome boring_challenge` | /datadome/boring-challenge | 30-100 | Internal DD term, near-zero coverage. |
| `datadome boringChallenge` | redirect → above | 20-80 | Variant. |
| `datadome wasm` | /datadome/wasm | 100-300 | Lots of mentions, no pillar page. |
| `datadome vm` | /datadome/vm | 50-200 | Same situation. |
| `datadome obfuscation` | /how-it-works | 200-500 | Some coverage, mostly stale. |
| `datadome deobfuscator` | /datadome/deobfuscator | 100-400 | Owned territory once we publish. |

### tier 2, medium competition (rank in 8-16 weeks with quality)

| keyword | page | rough monthly volume | competitors |
|---|---|---|---|
| `datadome solver` | /datadome/solver | 500-1500 | ZenRows, Scrapfly, capsolver, 2captcha |
| `datadome captcha bypass` | /datadome/bypass | 1000-3000 | ZenRows, ScrapingAnt, BrightData |
| `datadome bypass` | /datadome/bypass (primary) | 2000-5000 | ZenRows, Scrapfly, Smartproxy, ScraperAPI |
| `datadome captcha solver` | /datadome/solver | 800-2000 | capsolver, 2captcha |
| `datadome reverse engineering` | /how-it-works | 200-500 | Few good pages |
| `datadome anti-bot` | /datadome/about (intro hub) | 500-1500 | Vendor pages |
| `bypass datadome` | /datadome/bypass | 1500-4000 | Same as above |

### tier 3, branded / discovery

| keyword | page |
|---|---|
| `datadome-deobfuscator` | /  (homepage) |
| `glizzykingdreko datadome` | / |
| `takionapi datadome` | / + outbound link to takionapi.tech |
| `open source datadome solver` | / + /datadome/solver |

### tier 4, supporting / informational

These build topical authority around the cluster. Lower volume each but cumulative.

- `datadome how it works`
- `what is datadome`
- `datadome cookie`
- `datadome cookie analysis`
- `datadome challenge types`
- `datadome interstitial`
- `datadome captcha types`
- `datadome 403 forbidden`
- `datadome detection`
- `datadome script analysis`

## content pillars

```
PILLAR 1: how datadome works (technical)
  ├── /how-it-works (the deobfuscation walkthrough, full-length)
  ├── /datadome/wasm
  ├── /datadome/vm
  ├── /datadome/dynamic-challenge
  └── /datadome/boring-challenge

PILLAR 2: solving datadome (commercial-intent)
  ├── /datadome/bypass
  ├── /datadome/solver
  ├── /datadome/captcha-solver
  └── /datadome/api  → TakionAPI integration page

PILLAR 3: tooling (the actual product)
  ├── / (the dashboard)
  ├── /docs/cli
  ├── /docs/library
  ├── /docs/api-reference
  └── /changelog

PILLAR 4: trust / authority
  ├── /about
  ├── /blog (cross-post Medium articles + originals)
  └── /faq
```

Internal linking rule: every pillar-3 (tool) page links once to a pillar-2 (commercial) page in its closing CTA. Every pillar-1 (technical) page links to the matching pillar-3 page ("try this in the dashboard"). Every pillar-2 page links once outbound to TakionAPI.

## E-E-A-T plan

Standard SEO consultant fluff is useless here. Concrete signals:

| Signal | Implementation |
|---|---|
| Author bio | `/about` page with photo, GitHub stars, Medium follower count, list of antibot articles, TakionAPI founder mention. Same bio block embedded in every long-form page footer. |
| Open-source proof | Link to `github.com/glizzykingdreko/datadome-v2-deobfuscator` from every page header. Show GitHub star count badge. |
| Tool demo | The `/` dashboard IS the demo. Anyone landing on a content page can hit "try it" and run the deobfuscator on their own input. Massive trust signal. |
| Article history | Cross-link to existing Medium articles on DataDome. Embed the Medium follow widget in `/about`. |
| Last-updated dates | Every content page shows `last updated: YYYY-MM-DD`. Refresh quarterly. |
| Public changelog | `/changelog` lists every npm version, what changed, when. |
| Citations / outbound | Don't be precious. Link to ZenRows / Scrapfly when they have a useful piece of context. Outbound links to authoritative sources improve trust. |
| Schema markup | `Person` for author bio, `SoftwareApplication` for the tool, `TechArticle` for content, `FAQPage` for Q&A blocks, `Organization` for TakionAPI references. |

## technical foundation

| Requirement | Status / target |
|---|---|
| HTTPS | Auto via Vercel |
| Mobile responsive | Done (already responsive in current build) |
| Core Web Vitals | LCP < 2s, INP < 200ms, CLS < 0.1. Single-page dashboard easily hits this. Content pages need to keep image weight low. |
| Server-rendered HTML | Already SSR-friendly (plain HTML). Content pages must be server-rendered, not React-SPA. Consider Astro or plain HTML + Vercel. |
| robots.txt | Allow all. Disallow `/api/`. |
| sitemap.xml | Auto-generate from URL list. Submit to Google Search Console + Bing. |
| llms.txt | Add at root. Include canonical URL list, project description, open-source repo link. |
| Open Graph + Twitter Card | Per-page. OG image showing the dashboard for `/`, custom OG images for each content page. |
| Canonical tags | Self-referential per page. Important for the camelCase / snake_case redirects. |
| Schema.org | See E-E-A-T table above. JSON-LD in `<head>`. |
| Internal search | Skip for v1. Add when content > 30 pages. |
| Page speed | Strip Prism CDN to local hosting once content site exists, defer non-critical JS, no analytics on tool pages (privacy + speed). |

## GEO / AI search optimization

Probably more important than classical Google for this audience.

- **Question-answer formatting.** Every content page opens with a 1-2 sentence direct answer in plain text. LLMs lift these for citations.
- **FAQPage schema** on every content page. 5-8 questions per page, real questions actual users ask.
- **Listicles where appropriate.** "5 ways DataDome detects bots", "What's inside the wasm payload", etc. AI Overviews love structured lists.
- **Source citation pattern.** When making technical claims, link to the open-source code that proves it. LLMs prefer pages that cite their own source.
- **No paywall, no login, no auth.** Crawlable HTML throughout.
- **llms.txt** at the root with a curated canonical-URL list.

## what NOT to do

- No keyword stuffing. The audience is technical and will close the tab.
- No AI-generated content. Every page is glizzykingdreko's voice (or a writer briefed on it).
- No "ultimate guide" listicle bloat. Each page should be as long as it needs to be, no longer.
- No hiding TakionAPI behind soft-sells. One clear CTA per page in the closing third.
- No subdomain split (`deobfuscator.takionapi.tech`). Use `takionapi.tech/tools/datadome-deobfuscator/*` so all link equity stays on one domain.
- No comparison pages until tier 1 + tier 2 are ranked. They're high-converting but require existing authority to rank.

## KPI targets

Conservative numbers assuming no paid promotion, just organic growth.

| metric | baseline (week 0) | 3 months | 6 months | 12 months |
|---|---|---|---|---|
| Organic monthly traffic | 0 | 800 | 4,000 | 15,000 |
| Indexed pages | 1 | 12 | 25 | 40 |
| Tier 1 keywords ranked top-10 | 0 | 6 | 8 | 8 |
| Tier 2 keywords ranked top-10 | 0 | 1 | 4 | 6 |
| GitHub stars (proxy for authority) | current+0 | +200 | +800 | +2000 |
| npm weekly downloads | low | 200 | 800 | 2500 |
| AI Overview citations | 0 | 2-3 | 8-12 | 20+ |
| Backlinks (referring domains) | low | 15 | 40 | 100 |
| TakionAPI clicks from popup | 0 | 200/mo | 800/mo | 3000/mo |

## risks

| risk | mitigation |
|---|---|
| DataDome changes script, deobfuscator breaks | Public changelog with "supported as of" dates per bundle. Auto-test on every reference input. |
| Search interest stays niche | Push GEO/LLM citations as harder priority than classic SEO; the small audience is high-intent. |
| Competing solvers (ZenRows, Scrapfly) outspend on content | Stay technical. They write surface-level. Owning the deep-dive territory (`wasm`, `VM`, `boring_challenge`) is defensible against ad budget. |
| Google deindexes for "anti-bot bypass" terms | Frame all commercial copy as "research / case study", same approach the Medium articles already use. Outbound link to TakionAPI is fine; don't sell on the page. |

## next step

Read `IMPLEMENTATION-ROADMAP.md` for the phased build-out. Read `SITE-STRUCTURE.md` for the URL layout. Read `CONTENT-CALENDAR.md` for what to write and when.
