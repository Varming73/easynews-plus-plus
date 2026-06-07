<div align="center"><img src="https://i.imgur.com/1adWebT.png" alt="Easynews++ Logo"></div>
<h1 align="center" id="title">Easynews++</h1>
<div align="center">

![Easynews++ Logo](https://img.shields.io/badge/Easynews%2B%2B-Addon-blue?style=for-the-badge)
![Version](https://img.shields.io/github/v/release/Varming73/easynews-plus-plus?style=for-the-badge&label=Version)
![Checks](https://img.shields.io/github/check-runs/Varming73/easynews-plus-plus/main?style=for-the-badge&label=Checks)

</div>

**Easynews++** is an open-source addon that turns your Easynews account into a streaming source for Stremio and compatible apps like Omni, Vidi, Fusion and Nuvio. Plug in your Easynews credentials and it searches Easynews for whatever you're trying to watch, then filters and sorts the results by quality, size and language so the best stream sits right at the top.

Built upon the foundation of Easynews+, it implements a different authentication approach to ensure seamless operation across various platforms — including Stremio, Omni, Vidi, Fusion and Nuvio.

> [!NOTE]
> This is an **actively maintained fork** of [Easynews++](https://github.com/panteLx/easynews-plus-plus). Upstream development by panteLx was discontinued in June 2025; this fork continues maintenance with ongoing bug fixes and improvements. It is community-maintained and is not affiliated with the original author or with Easynews.

**Public instance:** none — this fork doesn't host one. [Self-host it](#-self-hosting) in a few minutes using the guide below.

---

## ✨ Features

- 🔍 **Smart title matching** — handles multi-word titles, odd naming and special characters, with an optional strict mode (on by default)
- 🌍 **Custom titles & TMDB translations** — so foreign and alternate titles still resolve to the right content
- 🎚️ **Sort your way** — by quality, language, size or date
- 🧹 **Clean results** — samples, spam and broken files are filtered out automatically
- ⭐ **Preferred audio language** is prioritized and flagged in the results
- 🎛️ **Filters** for resolution, max file size and results-per-quality
- ⚡ **In-memory caching** with a configurable TTL keeps repeat lookups fast
- 🌐 **13-language UI** with seamless switching
- 🏠 **Self-hostable** via Docker, Node or Cloudflare Workers

Adding alternate or translated titles to [`custom-titles.json`](./custom-titles.json) is the easiest way to improve matching for content the metadata providers get wrong.

---

## 🏠 Self-Hosting

There's no public instance, so you run your own. Docker Compose is the quickest path:

```bash
# Clone the repository
git clone https://github.com/Varming73/easynews-plus-plus.git && cd easynews-plus-plus
# Copy the example environment file
cp .env.example .env
# Start the container
docker-compose up -d
```

Then open `http://localhost:1337/` and configure the addon. The bundled `docker-compose.yml` uses the pre-built image from GitHub Container Registry by default, so there's nothing to build.

Prefer to run it from source, deploy to a Cloudflare Worker, or set it up for development? See **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)**.

---

## ⚙️ Configuration

Most settings — credentials, preferred language, sorting, quality filters — are configured on the addon's own **configuration page** when you install it. No server config needed for everyday use.

For self-hosters, behavior can be tuned with environment variables (port, log level, cache sizes, `TMDB_API_KEY` for translated-title search, and the `/resolve` streaming proxy). The full reference lives in **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)**.

> [!NOTE]
> As of recent versions the addon no longer embeds your Easynews credentials in stream URLs by default — streams are routed through a `/resolve` proxy instead. If an existing install shows a "reconfigure" message, re-install it from the configuration page. See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md#streaming--security) for details.

---

## ❓ FAQ

### What is Easynews?

Easynews is a premium Usenet provider with a web-based browser that lets you search, preview and download files from Usenet without a separate newsreader. It works as an alternative to debrid services (Real-Debrid, Premiumize, AllDebrid, etc.). **An active Easynews subscription is required to use this addon.**

### I can see the title on Easynews, so why does the addon show no streams (or only a 1-minute clip)?

The addon can only play files that are already complete, ready-to-watch videos. A lot of content on Usenet — and therefore on Easynews — isn't stored that way. It's often uploaded as a set of **compressed archive files**: a single movie split into dozens of pieces (`.rar` parts) and frequently locked with a **password**. To watch one of those you'd first have to download every piece, reassemble them and unlock them with a password that lives on a separate website — something a streaming addon can't do on the fly.

When that archived version is the only one available, two things happen:

1. The actual release is invisible to the addon, because it isn't a playable video file.
2. The only plain video left is usually a short **sample** — a 1–2 minute preview the uploader includes. The addon deliberately hides these, so you don't tap a "movie" and get a one-minute clip.

The result is "no streams," even though the title clearly appears on Easynews. This isn't a bug, and there's normally nothing to reconfigure — it simply depends on how that particular release was uploaded. Different uploads of the same title are often plain video files, so another episode, a different release, or the same title re-uploaded later may play just fine.

> [!TIP]
> If you self-host with debug logging enabled (`EASYNEWS_LOG_LEVEL=debug`), the log spells this out — for example: _"Only sample files indexed … the full release is likely posted only as packed/password-protected RAR archives, which are not directly streamable."_

**More questions** — caching, title matching, sorting, language filtering and platform compatibility — are answered in **[docs/FAQ.md](./docs/FAQ.md)**.

---

## 🤝 Contributing

Issues, fixes and custom-title additions are welcome on [GitHub](https://github.com/Varming73/easynews-plus-plus). For local setup and the release process, see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md#development).

## 🙏 Credits

- [panteLx/easynews-plus-plus](https://github.com/panteLx/easynews-plus-plus) — Easynews++, the upstream project this fork is based on
- [sleeyax/stremio-easynews-addon](https://github.com/Sleeyax/stremio-easynews-addon) — repository structure, base code and inspiration
- [Viren070/AIOStreams](https://github.com/Viren070/AIOStreams) — issue templates
- Everyone who has contributed through code, testing and ideas

## 📄 License

[MIT](./LICENSE)

> [!NOTE]
> This is an independent, fan-made addon for Easynews. An active Easynews subscription is required for use. This project is not affiliated with Easynews.
