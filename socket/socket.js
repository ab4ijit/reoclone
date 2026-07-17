/**
 * Socket handler for ReoClone.
 *
 * For every clone request we create a dedicated working folder named
 * `clone-me-<timestamp>` so each job is isolated, run the built-in crawler,
 * then zip the result into /public/sites and tell the client to auto-download.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const archiver = require('archiver');
const { cloneWebsite, normalizeUrl } = require('../crawler');

const WORK_ROOT = path.join(os.tmpdir(), 'reoclone-jobs');
const SITES_DIR = path.join(__dirname, '..', 'public', 'sites');

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
  ensureDir(SITES_DIR);

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

      // Timestamp comes from the request so the module stays pure/testable.
      const stamp = Date.now();
      const jobFolder = `clone-me-${stamp}`;
      const workDir = path.join(WORK_ROOT, jobFolder);
      ensureDir(workDir);

      console.log('Clone request %s -> %s', token, entry.href);
      emit({ progress: `Starting clone of ${entry.host}...` });

      try {
        const result = await cloneWebsite(entry.href, workDir, {
          onProgress: (msg) => emit({ progress: msg }),
          onFile: () => {},
        });

        if (result.pages === 0) {
          emit({ progress: 'Error: could not download any pages from this site.', error: true });
          fs.rmSync(workDir, { recursive: true, force: true });
          return;
        }

        emit({ progress: 'Converting' });

        const zipName = `${slugifyHost(result.host)}-${stamp}`;
        const zipPath = path.join(SITES_DIR, `${zipName}.zip`);
        const bytes = await zipFolder(workDir, zipPath);

        console.log('Archived %s (%d bytes)', zipName, bytes);
        emit({
          progress: 'Completed',
          file: zipName,
          pages: result.pages,
          assets: result.assets,
        });
      } catch (err) {
        console.error('Clone failed:', err);
        emit({ progress: `Error: ${err.message}`, error: true });
      } finally {
        // Clean up the working folder; the zip in /public/sites remains.
        fs.rm(workDir, { recursive: true, force: true }, () => {});
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
    });
  });
};
