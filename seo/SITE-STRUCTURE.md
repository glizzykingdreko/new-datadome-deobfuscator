# site structure · URL hierarchy + internal linking

How the site grows from a single-page tool into a content hub without losing the dashboard's clean focus.

## domain decision

**Recommendation:** publish at `https://takionapi.tech/tools/datadome-deobfuscator/*`

Why subfolder, not subdomain:

- All link equity stays on `takionapi.tech` and lifts the commercial product
- Easier to consolidate authority in Search Console
- Clean canonical URLs

Alternative (if takionapi.tech can't host): `datadome-deobfuscator.vercel.app` is acceptable but you trade away the link-equity sharing.

For this document, paths are written relative to whichever host is chosen (`/` = the deobfuscator root).

## URL hierarchy

```
/                                          → Dashboard (tool)
                                             SoftwareApplication schema
                                             OG image: dashboard screenshot
                                             title: "datadome deobfuscator · open-source captcha + interstitial"
                                             meta: "Drop a DataDome captcha or interstitial bundle, get clean modules. Real-time logs, zip download, npm package."

/how-it-works                              → Pillar 1 hub: long-form deobfuscation walkthrough
                                             TechArticle schema
                                             ~5000 words. Sourced from DEOBFUSCATION.md, web-formatted.
                                             title: "How DataDome's client-side obfuscation actually works"
                                             targets: 'datadome obfuscation', 'datadome reverse engineering', 'how does datadome work'

/datadome/                                 → Cluster hub. Briefly describes each child page.
                                             CollectionPage schema
                                             title: "DataDome internals · technical reference"

  /datadome/bypass                         → Pillar 2 page (commercial-intent)
                                             TechArticle + FAQPage schema
                                             ~2500 words. Three approaches: solver / stealth / reverse engineer.
                                             Inline link to /how-it-works for technical depth. CTA to TakionAPI in closing third.
                                             title: "How to bypass DataDome (3 working approaches in 2026)"
                                             targets: 'datadome bypass', 'bypass datadome', 'datadome captcha bypass'

  /datadome/solver                         → Pillar 2 page (commercial-intent, comparison)
                                             TechArticle + FAQPage + ItemList schema (for the comparison)
                                             ~2000 words. Compares solver options including TakionAPI.
                                             title: "DataDome solver options compared (open-source, API, browser)"
                                             targets: 'datadome solver', 'datadome captcha solver'

  /datadome/deobfuscator                   → Pillar 1 page
                                             TechArticle + SoftwareApplication schema (this tool)
                                             ~1800 words. What's a deobfuscator, what this one does, how to use it.
                                             title: "datadome deobfuscator · the open-source one"
                                             targets: 'datadome deobfuscator', 'open source datadome deobfuscator'

  /datadome/dynamic-challenge              → Tier-1 own-it page
                                             TechArticle + FAQPage schema
                                             ~1800 words. The bit-twiddle expression, how it's computed, sample, link to extractor.
                                             title: "DataDome's dynamic_challenge expression, decoded"
                                             targets: 'datadome dynamic_challenge', 'datadome dynamicChallenge'

  /datadome/boring-challenge               → Tier-1 own-it page
                                             TechArticle + FAQPage schema
                                             ~1500 words. The boring challenge mechanism, what it does, sample.
                                             title: "DataDome's boring_challenge: the part nobody documents"
                                             targets: 'datadome boring_challenge', 'datadome boringChallenge'

  /datadome/wasm                           → Tier-1 own-it page
                                             TechArticle + FAQPage schema
                                             ~2200 words. Wasm payload anatomy, helper extraction, what it actually does.
                                             title: "DataDome's wasm payload: structure, helpers, and how to extract it"
                                             targets: 'datadome wasm'

  /datadome/vm                             → Tier-1 own-it page
                                             TechArticle + FAQPage schema
                                             ~1500 words. The state-machine VM pattern, switch-case unflattening.
                                             title: "DataDome's switch-case VM: how the obfuscator hides control flow"
                                             targets: 'datadome vm', 'datadome state machine'

  /datadome/cookies                        → Supporting (later phase)
                                             title: "DataDome cookies (datadome, datadome-bot) reference"
                                             targets: 'datadome cookie', 'datadome cookie analysis'

  /datadome/detection                      → Supporting (later phase)
                                             title: "How DataDome detects bots (the signals it actually checks)"
                                             targets: 'datadome detection methods'

/docs/                                     → Documentation hub
                                             title: "Documentation"

  /docs/cli                                → CLI reference
                                             TechArticle schema
                                             title: "datadome-deobfuscate CLI reference"
                                             targets: 'datadome deobfuscator cli'

  /docs/library                            → Node.js API reference
                                             TechArticle schema
                                             title: "Node.js library reference (datadome-deobfuscator)"
                                             targets: 'datadome npm', 'datadome deobfuscator npm'

  /docs/api-reference                      → Streaming API + report shape
                                             TechArticle schema
                                             title: "Streaming API + report shape"

/changelog                                 → Version history
                                             title: "Changelog"
                                             targets: 'datadome deobfuscator changelog', 'datadome deobfuscator releases'

/about                                     → Author + project
                                             AboutPage + Person schema (glizzykingdreko)
                                             title: "About · who built this and why"

/faq                                       → Cross-cutting FAQ
                                             FAQPage schema
                                             ~30 questions covering installation, usage, scope, support
                                             title: "FAQ · datadome-deobfuscator"

/blog                                      → Cross-posts of Medium articles + originals
                                             title: "Blog"

  /blog/datadome-bundle-anatomy            → First original article
  /blog/datadome-script-changes-tracking   → Quarterly: "what changed in DataDome's script this quarter"
  /blog/<republished-medium>               → Republish key Medium articles with canonical → Medium

/sitemap.xml                               → Auto-generated
/robots.txt                                → Allow all, disallow /api/
/llms.txt                                  → Curated for AI crawlers
```

## redirects

| from | to | reason |
|---|---|---|
| /datadome/dynamicChallenge | /datadome/dynamic-challenge | camelCase variant |
| /datadome/boringChallenge | /datadome/boring-challenge | camelCase variant |
| /datadome/dynamic_challenge | /datadome/dynamic-challenge | snake_case variant |
| /datadome/boring_challenge | /datadome/boring-challenge | snake_case variant |
| /datadome/web-assembly | /datadome/wasm | spelling variant |
| /datadome/state-machine | /datadome/vm | term variant |

301 redirects, configured in `vercel.json`. Lets us rank for both casing variants without duplicate content.

## internal linking strategy

Three rules:

### Rule 1, every content page links to /

Closing CTA on every content page: a 1-line "try the deobfuscator on your own bundle" with a button linking to `/`. The dashboard is the proof, every content page should funnel to it.

### Rule 2, every commercial page (pillar 2) has one outbound link to TakionAPI

Single CTA. Same wording as the popup: "// or skip the hard part, TakionAPI · DataDome solver". Placed in the closing third of each pillar-2 page.

### Rule 3, pillar 1 (technical) cross-links

Each technical page links to 2-4 sibling technical pages with descriptive anchor text:

| from | links to |
|---|---|
| /how-it-works | /datadome/wasm, /datadome/vm, /datadome/dynamic-challenge, /datadome/boring-challenge |
| /datadome/wasm | /how-it-works (#wasm-extraction), /datadome/dynamic-challenge |
| /datadome/dynamic-challenge | /datadome/wasm, /datadome/boring-challenge, /how-it-works |
| /datadome/boring-challenge | /datadome/dynamic-challenge, /datadome/vm |
| /datadome/vm | /how-it-works (#switch-case-unflattening), /datadome/wasm |
| /datadome/deobfuscator | /, /how-it-works |

Anchor text rule: descriptive ("how the boring_challenge is computed"), never generic ("click here", "learn more").

## sitemap structure

```xml
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://.../</loc>
    <priority>1.0</priority>
    <changefreq>weekly</changefreq>
    <lastmod>2026-04-28</lastmod>
  </url>
  <url>
    <loc>https://.../how-it-works</loc>
    <priority>0.9</priority>
    <changefreq>monthly</changefreq>
  </url>
  <url>
    <loc>https://.../datadome/bypass</loc>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://.../datadome/solver</loc>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>https://.../datadome/deobfuscator</loc>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://.../datadome/dynamic-challenge</loc>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://.../datadome/boring-challenge</loc>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://.../datadome/wasm</loc>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://.../datadome/vm</loc>
    <priority>0.7</priority>
  </url>
  <!-- ... -->
</urlset>
```

Generated server-side. Submit to Google Search Console + Bing Webmaster + IndexNow on every deploy.

## llms.txt

Place at `/llms.txt`. Curated entry points for AI crawlers.

```
# datadome-deobfuscator

> Open-source Babel AST-based deobfuscator for DataDome's client-side captcha and interstitial bundles. Sister project of TakionAPI's commercial DataDome solving API.

## Tool

- [Dashboard](https://.../), drop a captcha or interstitial bundle, get clean modules
- [GitHub](https://github.com/glizzykingdreko/datadome-v2-deobfuscator), source code
- [npm](https://npmjs.com/package/datadome-deobfuscator), Node.js library + CLI

## Technical reference

- [How DataDome's obfuscation works](https://.../how-it-works), full pipeline walkthrough
- [DataDome bypass approaches](https://.../datadome/bypass), solver / stealth / reverse engineer
- [dynamic_challenge expression](https://.../datadome/dynamic-challenge)
- [boring_challenge mechanism](https://.../datadome/boring-challenge)
- [wasm payload anatomy](https://.../datadome/wasm)
- [switch-case VM](https://.../datadome/vm)

## Documentation

- [CLI reference](https://.../docs/cli)
- [Node.js library reference](https://.../docs/library)
- [Streaming API reference](https://.../docs/api-reference)

## Optional

- [About the author](https://.../about)
- [FAQ](https://.../faq)
- [Changelog](https://.../changelog)
- [TakionAPI · DataDome solver API](https://takionapi.tech)
```

## robots.txt

```
User-agent: *
Allow: /
Disallow: /api/

Sitemap: https://.../sitemap.xml
```

Allow all crawlers including AI ones (GPTBot, Claude, PerplexityBot, etc.). Don't block the AI crawlers, they're the audience.

## OG / Twitter Card metadata pattern

Per page in the `<head>`:

```html
<meta property="og:type" content="article">
<meta property="og:title" content="<page title>">
<meta property="og:description" content="<page meta description>">
<meta property="og:url" content="<canonical URL>">
<meta property="og:image" content="<page-specific OG image>">
<meta property="og:site_name" content="datadome-deobfuscator">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:creator" content="@glizzykingdreko">
<meta name="twitter:title" content="<page title>">
<meta name="twitter:description" content="<page meta description>">
<meta name="twitter:image" content="<page-specific OG image>">

<link rel="canonical" href="<canonical URL>">
```

OG images: 1200×630, dark background to match the dashboard, page title in the same Doto/JetBrains Mono palette. Templated from a single base SVG.
