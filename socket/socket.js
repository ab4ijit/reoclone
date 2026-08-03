/**
 * Socket handler for ReoClone.
 *
 * Each clone request runs in its own `clone-me-<timestamp>` temp folder,
 * gets zipped into another temp file, and is handed to the browser through
 * a one-time download id. Nothing is stored under the app's public folder.
 *
 * Robustness details that keep a long clone from "stopping":
 *  - Progress is throttled (a few updates per second, not one per file) so a
 *    large site can't flood the socket and force a disconnect.
 *  - The crawl runs independent of the socket; if the browser blips, the job
 *    keeps going. The finished result is remembered per token so a
 *    reconnecting client immediately gets its download link.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { cloneWebsite, normalizeUrl } = require('../crawler');
const downloads = require('../downloads');

const WORK_ROOT = path.join(os.tmpdir(), 'reoclone-jobs');
const PROGRESS_INTERVAL_MS = 300; // coalesce progress updates into this window

// Per-token job state so a reconnecting client can pick the result back up.
// token -> { status, host, lastLine, fileCount, result?, error? }
const jobs = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugifyHost(host) {
  return host.replace(/[^a-z0-9.-]/gi, '_');
}

function zipFolder(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(archive.pointer()));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

module.exports = (io) => {
  ensureDir(WORK_ROOT);

  io.on('connection', (socket) => {
    // If this client reconnects while (or after) a job for its token ran,
    // replay the current state so the UI never gets stuck on "Disconnected".
    socket.on('resume', (data) => {
      const token = data && data.token;
      if (!token) return;
      const job = jobs.get(token);
      if (!job) return;
      if (job.status === 'done' && job.result) {
        io.emit(token, { progress: 'Completed', ...job.result });
      } else if (job.status === 'error') {
        io.emit(token, { progress: job.error || 'Error', error: true });
      } else if (job.status === 'running') {
        io.emit(token, {
          progress: `Still cloning ${job.host}… (${job.fileCount} files so far)`,
          resumed: true,
        });
      }
    });

    socket.on('request', async (data) => {
      const token = data && data.token;
      const website = data && data.website;

      if (!token) return;

      // Guard: don't start a second crawl for a token already running one.
      const existing = jobs.get(token);
      if (existing && existing.status === 'running') {
        io.emit(token, {
          progress: `A clone of ${existing.host} is already running…`,
          resumed: true,
        });
        return;
      }

      if (!website) {
        io.emit(token, { progress: 'Error: missing website.', error: true });
        return;
      }

      let entry;
      try {
        entry = normalizeUrl(website);
      } catch {
        io.emit(token, { progress: `Error: "${website}" is not a valid URL.`, error: true });
        return;
      }

      const stamp = Date.now();
      const jobFolder = `clone-me-${stamp}`;
      const workDir = path.join(WORK_ROOT, jobFolder);
      const zipPath = path.join(WORK_ROOT, `${jobFolder}.zip`);
      ensureDir(workDir);

      const job = { status: 'running', host: entry.host, lastLine: '', fileCount: 0 };
      jobs.set(token, job);

      console.log('Clone request %s -> %s', token, entry.href);
      io.emit(token, { progress: `Starting clone of ${entry.host}...` });

      // Throttled progress: buffer the latest line + running count and flush
      // at most every PROGRESS_INTERVAL_MS. This prevents socket flooding on
      // big sites (the real cause of the mid-clone disconnects).
      let flushTimer = null;
      let dirty = false;
      const flush = () => {
        flushTimer = null;
        if (!dirty) return;
        dirty = false;
        io.emit(token, { progress: job.lastLine, fileCount: job.fileCount });
      };
      const scheduleFlush = () => {
        dirty = true;
        if (!flushTimer) flushTimer = setTimeout(flush, PROGRESS_INTERVAL_MS);
      };

      try {
        const result = await cloneWebsite(entry.href, workDir, {
          onProgress: (msg) => {
            job.lastLine = msg;
            if (typeof msg === 'string' && msg.indexOf('200 OK') !== -1) {
              job.fileCount++;
            }
            scheduleFlush();
          },
        });

        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

        if (result.pages === 0) {
          job.status = 'error';
          job.error = 'Error: could not download any pages from this site.';
          io.emit(token, { progress: job.error, error: true });
          fs.rmSync(workDir, { recursive: true, force: true });
          return;
        }

        io.emit(token, { progress: 'Converting' });

        await zipFolder(workDir, zipPath);
        fs.rm(workDir, { recursive: true, force: true }, () => {});

        const downloadId = crypto.randomBytes(16).toString('hex');
        const filename = `${slugifyHost(result.host)}-${stamp}.zip`;
        // When the zip is finally consumed/expired, forget the job too.
        downloads.register(downloadId, zipPath, filename, () => {
          const j = jobs.get(token);
          if (j && j.result && j.result.downloadId === downloadId) jobs.delete(token);
        });

        job.status = 'done';
        job.result = { downloadId, filename, pages: result.pages, assets: result.assets };

        console.log('Ready for download: %s (%s)', filename, downloadId);
        io.emit(token, { progress: 'Completed', ...job.result });
      } catch (err) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        console.error('Clone failed:', err);
        job.status = 'error';
        job.error = `Error: ${err.message}`;
        io.emit(token, { progress: job.error, error: true });
        fs.rm(workDir, { recursive: true, force: true }, () => {});
        fs.rm(zipPath, { force: true }, () => {});
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
