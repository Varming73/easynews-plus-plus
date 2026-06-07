# FAQ — How it works

The [README](../README.md) covers the two most common questions ("what is Easynews?" and
"why do I sometimes get no streams?"). This page goes deeper into how the addon actually
behaves.

- [How does caching work?](#how-does-caching-work)
- [How does title matching work?](#how-does-title-matching-work)
- [How do custom titles & TMDB translations work?](#how-do-custom-titles--tmdb-translations-work)
- [Why can't I find specific content?](#why-cant-i-find-specific-content)
- [How does quality prioritization work?](#how-does-quality-prioritization-work)
- [What sorting options are available?](#what-sorting-options-are-available)
- [How does the language filter work?](#how-does-the-language-filter-work)
- [How is platform compatibility handled?](#how-is-platform-compatibility-handled)
- [Platform support](#platform-support)

---

## How does caching work?

The addon caches in memory at two levels to cut down on API calls and speed up repeat
lookups:

1. Search results are cached per query (with a configurable TTL).
2. Whole stream requests are cached per set of user settings.

Both caches are bounded and expire after their TTL, so results stay reasonably fresh while
frequently accessed content responds quickly. Caches are in-memory only — they reset on
restart and aren't shared between worker instances.

## How does title matching work?

Matching is built to survive the messy ways titles get written:

1. Percentage-based similarity for multi-word titles
2. Common naming conventions (e.g. "The Movie" vs "Movie, The")
3. Special characters — spaces, punctuation, accents
4. An optional **strict mode**

With strict matching on (the default), only exact title matches are returned. Turn it off and
the addon uses fuzzy matching to surface related content.

## How do custom titles & TMDB translations work?

This is how the addon finds content listed under alternate or translated titles:

1. The original title is combined with custom titles and TMDB translations.
2. Additional titles from metadata are folded in.
3. With a `TMDB_API_KEY` set, TMDB supplies localized titles in your preferred language.
4. Translated titles are sanitized for better search accuracy.
5. Partial matching surfaces related variants.
6. Self-hosters can add their own entries to [`custom-titles.json`](../custom-titles.json).

## Why can't I find specific content?

First, check whether the content exists on [Easynews web search](https://members.easynews.com/).
If it's unavailable there — or only returns poor results (duration under 5 minutes, flagged as
spam, no video) — the addon won't find it either.

If it _does_ exist on Easynews but the addon misses it, the usual causes are:

- Title mismatches between the Easynews index and your player's metadata
- Unconventional title formats
- Special-character handling

Classic hard cases:

- Anime like `death note` with non-standard episode numbering
- Partial metadata matches (e.g. `Mission: Impossible - Dead Reckoning Part One`)
- Special characters (e.g. `WALL·E` vs `WALL-E`)

For these, self-host and add the troublesome titles to
[`custom-titles.json`](../custom-titles.json).

> See also the README's [_"I can see the title on Easynews, so why no streams?"_](../README.md#i-can-see-the-title-on-easynews-so-why-does-the-addon-show-no-streams-or-only-a-1-minute-clip)
> — packed/password-protected RAR releases are a common reason a title shows up but won't play.

## How does quality prioritization work?

By default the addon ranks streams by:

1. Resolution (4K/UHD → 1080p → 720p → 480p)
2. File size within a resolution (larger usually means better quality)
3. GB over MB
4. Numeric size within the same unit (e.g. 2 GB over 1 GB)

So the highest-quality option available tends to land at the top without manual filtering.

## What sorting options are available?

You pick the sort order on the configuration page:

1. **Quality First** (default) — resolution, then preferred language, then size
2. **Language First** — preferred language, then quality, then size
3. **Size First** — largest first, then quality, then language
4. **Date First** — newest first, then quality and language

All options use the same relevance-first API search and then sort the results locally.
For the strongest language prioritization, pair **Language First** with a preferred language.

## How does the language filter work?

Setting a preferred audio language changes how results are presented:

1. Choose your preferred language on the configuration page.
2. Streams with that audio appear first.
3. Other languages follow below.
4. Every stream shows its audio-language info in the description.
5. Your preferred language is marked with a star (⭐).

For the strongest effect, combine this with the **Language First** sort so your language stays
on top regardless of quality or size — without hiding the other options.

## How is platform compatibility handled?

Easynews++ implements the **Stremio addon protocol**, so any client that speaks it can use it
— Stremio plus compatible apps like Omni, Vidi, Fusion and Nuvio. Two design choices keep it
working across those clients:

1. Authentication that doesn't rely on the player sending Basic auth headers — stream URLs are
   routed through the addon's `/resolve` proxy, which handles auth and redirects the player to
   a clean CDN URL.
2. Response formats and stream-URL structure that behave consistently across devices.

---

## Platform support

> [!NOTE]
> This matrix is largely inherited from upstream and has **not** all been re-verified in this
> fork. Nuvio is confirmed working; the older tested/untested entries come from upstream. If
> you hit an issue on a specific platform, please open an issue.

### ✅ Tested / working

- Nuvio
- tvOS (Omni & Vidi)
- iOS (Fusion)
- Stremio
  - Windows (4.x stable & 5.x beta)
  - Linux
  - Web (browser)
  - Android Mobile (beta)
  - iOS (Web & TestFlight)
  - Android TV

### ⚠️ Partial or untested

- Stremio
  - macOS (internal player may have issues)
  - Android Mobile (stable)
  - Steam Deck
  - Raspberry Pi
  - Sony TV
  - Philips TV
  - Samsung TV (some models may have internal-player playback issues)

### ❌ Not supported

- Stremio on webOS
