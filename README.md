<div align="center">

# ◈ ReoClone

**Clone the full source and every asset of any website into a single, ready-to-open zip.**

No install. No external tools. Works offline.

</div>

---

## What it does

ReoClone crawls a website you point it at, downloads the HTML pages plus every asset they need (CSS, JavaScript, images, fonts), rewrites all the links to relative paths so the copy works offline, and packages everything into a single `.zip` that downloads automatically when it's done.

Live progress streams to your browser over a WebSocket — you watch each file land in real time, with a running file counter and progress bar.

## Why it's different

The original approach depended on the external `wget` binary, which isn't available on most Windows machines and many hosts. **ReoClone ships its own crawler written in pure Node.js** — nothing to install beyond `npm install`. It runs anywhere Node runs.

- 🧩 **Zero external binaries** — self-contained Node crawler using the built-in `fetch`.
- 🗂️ **Isolated jobs** — every clone runs in its own `clone-me-<timestamp>` working folder.
- 🔗 **Offline-ready** — same-site links and assets are rewritten to relative paths.
- 📦 **One-click zip** — the finished archive auto-downloads in the browser.
- 🎨 **Modern UI** — dark, animated interface with a live console and progress bar.
- 🛡️ **Safety caps** — bounded page/asset counts and per-request timeouts.

## Run it locally

```bash
git clone https://github.com/ab4ijit/reoclone.git
cd reoclone
npm install
npm start
```

Then open **http://localhost:3000/**, paste a URL, and hit **Clone site**.

## How it works

```
Browser ──(socket: request)──▶ Node server
                                 │
                                 ├─ crawler/  → fetch pages + assets, rewrite links
                                 │              into a temp clone-me-<timestamp> folder
                                 │
                                 └─ archiver  → zip the folder into a temp file,
                                 │              exposed via a one-time download id
                                 │
Browser ◀─(socket: progress ─────┘  + auto-download, then the zip is deleted)
```

| Piece | Role |
|-------|------|
| `crawler/index.js` | Dependency-free crawler: fetch, discover, download, rewrite. |
| `socket/socket.js` | Per-request job folder, runs the crawler, zips, streams progress. |
| `views/` | Handlebars templates for the UI. |
| `public/stylesheets/style.css` | The dark, animated theme. |

## Configuration

The crawler runs **unlimited by default** — it crawls every same-site page and asset it can find. The limits live in `crawler/index.js` and can be capped later (e.g. per subscription tier):

| Option | Default | Meaning |
|--------|---------|---------|
| `maxPages` | `Infinity` | Max HTML pages to crawl. |
| `maxAssets` | `Infinity` | Max assets to download. |
| `timeoutMs` | `45000` | Per-request timeout. |
| `concurrency` | `8` | Parallel downloads. |

## Where clones are stored

Nowhere permanent. Each clone is built in a temp folder, zipped, handed to your browser through a **one-time download link**, and then deleted. Undownloaded zips are dropped automatically after 15 minutes. The server keeps no copy.

## Please clone responsibly

Only clone websites you own or have permission to copy. ReoClone is meant for backups, offline archives, and learning — not for republishing other people's work.

## License

[MIT](./LICENSE) © 2026 [Abhijit](https://github.com/ab4ijit)
