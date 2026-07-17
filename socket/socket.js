/**
 * Socket handler for ReoClone.
 *
 * Each clone request runs in its own `clone-me-<timestamp>` temp folder,
 * gets zipped into another temp file, and is handed to the browser through
 * a one-time download id. Nothing is stored under the app's public folder —
 * the temp folder is deleted right after zipping, and the zip itself is
 * deleted the moment the user's download finishes.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { cloneWebsite, normalizeUrl } = require('../crawler');
const downloads = require('../downloads');

const WORK_ROOT = path.join(os.tmpdir(), 'reoclone-jobs');

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
    socket.on('request', async (data) => {
      const token = data && data.token;
      const website = data && data.website;
      const emit = (payload) => io.emit(token, payload);

      if (!website || !token) {
        emit({ progress: 'Error: missing website or token.', error: true });
        return;
      }

      let entry;
      try {
        entry = normalizeUrl(website);
      } catch {
        emit({ progress: `Error: "${website}" is not a valid URL.`, error: true });
        return;
      }

      const stamp = Date.now();
      const jobFolder = `clone-me-${stamp}`;
      const workDir = path.join(WORK_ROOT, jobFolder);
      const zipPath = path.join(WORK_ROOT, `${jobFolder}.zip`);
      ensureDir(workDir);

      console.log('Clone request %s -> %s', token, entry.href);
      emit({ progress: `Starting clone of ${entry.host}...` });

      try {
        const result = await cloneWebsite(entry.href, workDir, {
          onProgress: (msg) => emit({ progress: msg }),
        });

        if (result.pages === 0) {
          emit({ progress: 'Error: could not download any pages from this site.', error: true });
          fs.rmSync(workDir, { recursive: true, force: true });
          return;
        }

        emit({ progress: 'Converting' });

        await zipFolder(workDir, zipPath);

        // The working folder is no longer needed once it's zipped.
        fs.rm(workDir, { recursive: true, force: true }, () => {});

        // Register a one-time download; the zip is removed after it's served.
        const downloadId = crypto.randomBytes(16).toString('hex');
        const filename = `${slugifyHost(result.host)}-${stamp}.zip`;
        downloads.register(downloadId, zipPath, filename);

        console.log('Ready for download: %s (%s)', filename, downloadId);
        emit({
          progress: 'Completed',
          downloadId,
          filename,
          pages: result.pages,
          assets: result.assets,
        });
      } catch (err) {
        console.error('Clone failed:', err);
        emit({ progress: `Error: ${err.message}`, error: true });
        fs.rm(workDir, { recursive: true, force: true }, () => {});
        fs.rm(zipPath, { force: true }, () => {});
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
