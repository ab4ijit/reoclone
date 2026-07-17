/**
 * ReoClone crawler — a dependency-free website cloner.
 *
 * Replaces the old `wget` shell-out so the app runs anywhere Node runs
 * (Windows included) without any external binaries. It fetches the entry
 * page, discovers same-origin links and page assets, downloads them, and
 * rewrites references to relative paths so the copy works offline.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULTS = {
  maxPages: 60, // safety cap so a huge site can't run forever
  maxAssets: 600,
  timeoutMs: 20000,
  concurrency: 5,
};

const ASSET_ATTRS = ['src', 'href', 'poster', 'data-src'];
const PAGE_EXTENSIONS = ['', '.html', '.htm', '.php', '.asp', '.aspx'];

function normalizeUrl(input) {
  const withProto = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(withProto);
  url.hash = '';
  return url;
}

function safeSegment(segment) {
  return segment.replace(/[<>:"|?*\x00-\x1f]/g, '_');
}

// Map a URL to a on-disk relative path inside the clone folder.
function urlToLocalPath(url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/') || pathname === '') {
    pathname += 'index.html';
  }
  let rel = pathname.replace(/^\/+/, '');
  const segments = rel.split('/').map(safeSegment);
  rel = segments.join('/');

  // Preserve query strings by folding them into the filename.
  if (url.search) {
    const q = url.search.replace(/[<>:"|?*\x00-\x1f/\\]/g, '_');
    const ext = path.extname(rel);
    if (ext) {
      rel = rel.slice(0, -ext.length) + q + ext;
    } else {
      rel += q + '.html';
    }
  }
  if (!path.extname(rel)) {
    rel = rel.endsWith('/') ? rel + 'index.html' : rel + '/index.html';
  }
  return rel;
}

function isHtmlResponse(contentType, localPath) {
  if (contentType && contentType.includes('text/html')) return true;
  return /\.(html?|php|aspx?)$/i.test(localPath);
}

// Compute a relative href from one local file to another.
function relativeHref(fromLocal, toLocal) {
  const fromDir = path.dirname(fromLocal);
  let rel = path.relative(fromDir, toLocal).split(path.sep).join('/');
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
  return rel;
}

async function fetchWithTimeout(target, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ReoClone/1.0; +https://github.com/ab4ijit/reoclone)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clone a website into destDir.
 * @param {string} website     entry URL
 * @param {string} destDir     absolute output folder
 * @param {object} opts        { onProgress(msg), onFile(url), ...DEFAULTS }
 * @returns {Promise<{pages:number, assets:number, host:string}>}
 */
async function cloneWebsite(website, destDir, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const onProgress = opts.onProgress || (() => {});
  const onFile = opts.onFile || (() => {});

  const entry = normalizeUrl(website);
  const origin = entry.origin;
  const host = entry.host;

  const visited = new Set(); // urls we've already queued
  const localByUrl = new Map(); // url string -> local relative path
  const pageQueue = [entry.href];
  visited.add(entry.href);

  let pageCount = 0;
  let assetCount = 0;

  onProgress(`Resolving ${host}...`);

  // --- Phase 1: crawl HTML pages breadth-first, collecting assets. ---
  const assetUrls = new Set();
  const htmlDocs = []; // { localPath, html, url }

  while (pageQueue.length && pageCount < cfg.maxPages) {
    const batch = pageQueue.splice(0, cfg.concurrency);
    await Promise.all(
      batch.map(async (pageUrl) => {
        if (pageCount >= cfg.maxPages) return;
        let res;
        try {
          res = await fetchWithTimeout(pageUrl, cfg.timeoutMs);
        } catch (err) {
          onProgress(`Failed: ${pageUrl} (${err.message})`);
          return;
        }
        if (!res.ok) {
          onProgress(`${res.status} ${pageUrl}`);
          return;
        }
        pageCount++;
        const finalUrl = new URL(res.url);
        const localPath = urlToLocalPath(finalUrl);
        localByUrl.set(pageUrl, localPath);
        localByUrl.set(finalUrl.href, localPath);
        onProgress(`200 OK ${pageUrl}`);
        onFile(pageUrl);

        const html = await res.text();
        htmlDocs.push({ localPath, html, url: finalUrl });

        // Discover links + assets in this page.
        const links = extractRefs(html);
        for (const ref of links) {
          let abs;
          try {
            abs = new URL(ref, finalUrl);
          } catch {
            continue;
          }
          abs.hash = '';
          if (abs.origin !== origin) continue; // stay on same site
          const isPage = looksLikePage(abs);
          if (isPage) {
            if (!visited.has(abs.href) && pageCount + pageQueue.length < cfg.maxPages) {
              visited.add(abs.href);
              pageQueue.push(abs.href);
            }
          } else {
            assetUrls.add(abs.href);
          }
        }
      })
    );
  }

  // --- Phase 2: download assets. ---
  const assetList = [...assetUrls].slice(0, cfg.maxAssets);
  for (let i = 0; i < assetList.length; i += cfg.concurrency) {
    const batch = assetList.slice(i, i + cfg.concurrency);
    await Promise.all(
      batch.map(async (assetUrl) => {
        let res;
        try {
          res = await fetchWithTimeout(assetUrl, cfg.timeoutMs);
        } catch (err) {
          onProgress(`Asset failed: ${assetUrl}`);
          return;
        }
        if (!res.ok) return;
        const finalUrl = new URL(res.url);
        const localPath = urlToLocalPath(finalUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSafe(path.join(destDir, localPath), buf);
        localByUrl.set(assetUrl, localPath);
        localByUrl.set(finalUrl.href, localPath);
        assetCount++;
        onProgress(`200 OK ${assetUrl}`);
        onFile(assetUrl);
      })
    );
  }

  // --- Phase 3: rewrite HTML references to local relative paths. ---
  for (const doc of htmlDocs) {
    const rewritten = rewriteHtml(doc.html, doc.url, doc.localPath, origin, localByUrl);
    writeFileSafe(path.join(destDir, doc.localPath), rewritten);
  }

  return { pages: pageCount, assets: assetCount, host };
}

function looksLikePage(url) {
  const ext = path.extname(url.pathname).toLowerCase();
  if (!ext) return true;
  return PAGE_EXTENSIONS.includes(ext);
}

// Pull candidate URLs out of an HTML string (attributes + url() in styles).
function extractRefs(html) {
  const refs = new Set();
  const attrRe = new RegExp(`(?:${ASSET_ATTRS.join('|')})\\s*=\\s*["']([^"']+)["']`, 'gi');
  let m;
  while ((m = attrRe.exec(html))) {
    const ref = m[1].trim();
    if (ref && !ref.startsWith('data:') && !ref.startsWith('javascript:') && !ref.startsWith('#') && !ref.startsWith('mailto:') && !ref.startsWith('tel:')) {
      refs.add(ref);
    }
  }
  const cssUrlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = cssUrlRe.exec(html))) {
    const ref = m[1].trim();
    if (ref && !ref.startsWith('data:')) refs.add(ref);
  }
  const srcsetRe = /srcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html))) {
    for (const part of m[1].split(',')) {
      const ref = part.trim().split(/\s+/)[0];
      if (ref && !ref.startsWith('data:')) refs.add(ref);
    }
  }
  return refs;
}

// Replace absolute/root-relative references in HTML with local relative paths.
function rewriteHtml(html, pageUrl, pageLocal, origin, localByUrl) {
  return html.replace(/(\s(?:src|href|poster|data-src)\s*=\s*)(["'])([^"']+)\2/gi, (full, pre, quote, ref) => {
    const trimmed = ref.trim();
    if (
      !trimmed ||
      trimmed.startsWith('data:') ||
      trimmed.startsWith('javascript:') ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('mailto:') ||
      trimmed.startsWith('tel:')
    ) {
      return full;
    }
    let abs;
    try {
      abs = new URL(trimmed, pageUrl);
    } catch {
      return full;
    }
    abs.hash = '';
    if (abs.origin !== origin) return full; // leave external links intact
    const local = localByUrl.get(abs.href);
    if (!local) return full;
    const rel = relativeHref(pageLocal, local);
    return `${pre}${quote}${rel}${quote}`;
  });
}

function writeFileSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

module.exports = { cloneWebsite, normalizeUrl };
