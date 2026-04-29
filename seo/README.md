# SEO planning · datadome-deobfuscator

This directory holds the strategic SEO plan to make this site rank for every meaningful DataDome-internals search query: bypass, solver, deobfuscator, dynamic_challenge, boring_challenge, wasm, VM.

## what's in here

| File | What it is |
|---|---|
| [SEO-STRATEGY.md](./SEO-STRATEGY.md) | Master strategy. Audience, positioning, keyword tiers (1-4), content pillars, E-E-A-T plan, KPIs, risks. |
| [COMPETITOR-ANALYSIS.md](./COMPETITOR-ANALYSIS.md) | Honest read of the SERP for each target keyword. Who ranks, why, how to outrank. |
| [SITE-STRUCTURE.md](./SITE-STRUCTURE.md) | Full URL hierarchy, redirects, internal linking rules, sitemap layout, llms.txt template, OG metadata pattern. |
| [CONTENT-CALENDAR.md](./CONTENT-CALENDAR.md) | Week-by-week publishing plan. Content briefs, sequencing logic, voice guide for outsourced writing. |
| [IMPLEMENTATION-ROADMAP.md](./IMPLEMENTATION-ROADMAP.md) | Tactical execution. 4 phases, week-by-week tickets, exit criteria, dependencies. |

## reading order

If you're skimming: read this README, then `SEO-STRATEGY.md` § tl;dr, then `IMPLEMENTATION-ROADMAP.md` § "quick wins to ship in week 1".

If you're executing: read `SEO-STRATEGY.md` end-to-end, then `SITE-STRUCTURE.md`, then `IMPLEMENTATION-ROADMAP.md`.

If you're hiring a writer: send them `CONTENT-CALENDAR.md` and the [glizzykingdreko-voice style guide](~/.claude/skills/glizzykingdreko-voice/references/style-guide.md).

## one-paragraph summary

Tier-1 keywords (`dynamic_challenge`, `boring_challenge`, `wasm`, `VM` in DataDome context) are uncontested longtails. We own them in 4-8 weeks by writing one canonical page each. Tier-2 keywords (`bypass`, `solver`) are commercial-intent fights against ZenRows, Scrapfly, and CAPTCHA-solver vendors. We don't win those on ad spend. We win on E-E-A-T (open-source repo, working dashboard, glizzykingdreko's track record) and depth (technical content the marketing teams can't write). Phase 1 ships the dashboard publicly + 4 tier-1 pages in 4 weeks. Phase 2 builds the cluster spine. Phase 3 fights for tier-2. Phase 4 turns the site into the default citation for DataDome internals across both Google and AI search.

## quick numbers

| metric | 12-month target |
|---|---|
| Indexed pages | 40+ |
| Organic monthly traffic | 15,000 |
| Tier-1 keywords top-10 | 8/8 |
| Tier-2 keywords top-10 | 6/8 |
| AI Overview citations | 20+ |
| Referring domains | 100+ |
| TakionAPI clicks from popup | 3000/mo |

## start here

If you have 2 hours today, do the **"quick wins to ship in week 1"** checklist at the bottom of `IMPLEMENTATION-ROADMAP.md`. It puts the dashboard SEO-ready before any content work.
