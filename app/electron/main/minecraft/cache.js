const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Cache Manager - SHA1-deduplicated file cache with symlink support.
 * 
 * Structure:
 *   <minecraftPath>/cache/
 *     mods/<sha1>.jar
 *     resourcepacks/<sha1>.zip
 *     shaderpacks/<sha1>.zip
 * 
 * Profiles link to cache entries via symlinks (or copies on Windows if symlinks fail).
 */
class CacheManager {
  constructor(minecraftPath) {
    this.minecraftPath = minecraftPath;
    this.cacheDir = path.join(minecraftPath, 'cache');
    this.categoryDirs = {
      mods: path.join(this.cacheDir, 'mods'),
      resourcepacks: path.join(this.cacheDir, 'resourcepacks'),
      shaderpacks: path.join(this.cacheDir, 'shaderpacks'),
    };
  }

  async init() {
    for (const dir of Object.values(this.categoryDirs)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  /**
   * Get cache path for a file by category and SHA1
   */
  getCachePath(category, sha1, ext) {
    const sanitizedSha1 = sha1.replace(/[^a-f0-9]/gi, '');
    const safeCategory = this.categoryDirs[category];
    if (!safeCategory) throw new Error(`Unknown cache category: ${category}`);
    return path.join(safeCategory, `${sanitizedSha1}${ext}`);
  }

  /**
   * Check if a file exists in cache
   */
  async hasFile(category, sha1, ext) {
    try {
      await fs.access(this.getCachePath(category, sha1, ext));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compute SHA1 of a buffer
   */
  computeSha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
  }

  /**
   * Compute SHA1 of a file on disk
   */
  async computeFileSha1(filePath) {
    const buffer = await fs.readFile(filePath);
    return this.computeSha1(buffer);
  }

  /**
   * Verify file SHA1 against an expected hash
   */
  async verifyFileSha1(filePath, expectedSha1) {
    const actual = await this.computeFileSha1(filePath);
    return actual.toLowerCase() === String(expectedSha1).toLowerCase();
  }

  /**
   * Store a file in the cache (from buffer)
   * Returns the SHA1 hash
   */
  async storeFromBuffer(category, buffer, ext) {
    await this.init();
    const sha1 = this.computeSha1(buffer);
    const cachePath = this.getCachePath(category, sha1, ext);

    // Only write if not already cached
    try {
      await fs.access(cachePath);
    } catch {
      await fs.writeFile(cachePath, buffer);
    }

    return sha1;
  }

  /**
   * Store a file in the cache by copying from a source path
   * Returns the SHA1 hash
   */
  async storeFromFile(category, sourcePath, ext) {
    const buffer = await fs.readFile(sourcePath);
    return await this.storeFromBuffer(category, buffer, ext);
  }

  /**
   * Download a file and store it in the cache
   * Returns { sha1, cached } where cached=true if it was already in cache
   */
  async downloadAndStore(category, url, sha1, ext, options = {}) {
    await this.init();

    // If we already have this hash, skip download
    if (sha1 && await this.hasFile(category, sha1, ext)) {
      return { sha1, cached: true };
    }

    const dispatcher = options && typeof options.dispatch === 'function' ? options : options.dispatcher;
    const timeoutMs = Math.max(30000, Number(options.timeout) || 120000);
    const attempts = Math.max(1, Number(options.attempts) || 3);
    const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length
      ? options.retryDelays
      : [500, 1500, 3000];
    const retryStatusCodes = new Set([408, 429, 500, 502, 503, 504, 521, 522, 524]);
    let buffer;
    let lastError;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isRetryable = (error) => {
      if (retryStatusCodes.has(Number(error?.status))) return true;
      if (Number(error?.status) >= 400) return false;
      const message = String(error?.message || '').toLowerCase();
      return error?.retryable === true
        || error?.name === 'AbortError'
        || /aborted|timeout|timed out|econnreset|econnrefused|enotfound|eai_again|network|fetch failed|socket|terminated/.test(message);
    };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const externalSignal = options.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) controller.abort(externalSignal.reason);
      else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const fetchOpts = { signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) };
      try {
        const response = await fetch(url, fetchOpts);
        if (!response.ok) {
          let details = '';
          try {
            details = await response.text();
          } catch {
            details = '';
          }
          const error = new Error(`Download failed: ${response.status} ${response.statusText} for ${url}${details ? ` (${details})` : ''}`);
          error.status = response.status;
          error.statusText = response.statusText;
          throw error;
        }

        const totalBytes = Math.max(0, Number(response.headers.get('content-length')) || 0);
        const chunks = [];
        let receivedBytes = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            const data = Buffer.from(chunk);
            chunks.push(data);
            receivedBytes += data.length;
            options.onProgress?.({ receivedBytes, totalBytes, attempt, maxAttempts: attempts, url });
          }
          buffer = Buffer.concat(chunks);
        } else {
          buffer = Buffer.from(await response.arrayBuffer());
          receivedBytes = buffer.length;
          options.onProgress?.({ receivedBytes, totalBytes: totalBytes || receivedBytes, attempt, maxAttempts: attempts, url });
        }
        lastError = null;
        break;
      } catch (error) {
        if (externalSignal?.aborted) {
          const cancelled = new Error('Launch cancelled.');
          cancelled.code = 'LAUNCH_CANCELLED';
          throw cancelled;
        }
        if (error?.name === 'AbortError' || /aborted/i.test(error?.message || '')) {
          lastError = new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s for ${url}`);
          lastError.retryable = true;
        } else {
          lastError = error;
        }
        if (attempt >= attempts || !isRetryable(lastError)) break;
        const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
        options.onRetry?.({ attempt: attempt + 1, maxAttempts: attempts, delay, error: lastError, url });
        await sleep(delay);
      } finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', abortFromExternal);
      }
    }

    if (!buffer) {
      throw lastError || new Error(`Download failed for ${url}`);
    }

    const computedSha1 = this.computeSha1(buffer);

    // Verify hash if provided
    if (sha1 && computedSha1 !== sha1) {
      throw new Error(`SHA1 mismatch: expected ${sha1}, got ${computedSha1}`);
    }

    const finalSha1 = sha1 || computedSha1;

    // Already in cache check again (race condition guard)
    if (await this.hasFile(category, finalSha1, ext)) {
      return { sha1: finalSha1, cached: true };
    }

    await fs.writeFile(this.getCachePath(category, finalSha1, ext), buffer);
    return { sha1: finalSha1, cached: false };
  }

  /**
   * Create a symlink from cache → profile directory.
   * Falls back to copy on Windows if symlinks fail.
   */
  async linkToProfile(category, sha1, ext, fileName, profileDir, options = {}) {
    const cachePath = this.getCachePath(category, sha1, ext);
    const targetDir = path.join(profileDir, category);
    await fs.mkdir(targetDir, { recursive: true });

    const linkPath = path.join(targetDir, fileName);

    // Never create dangling symlinks: ensure the cache file exists first.
    // Forge treats dangling entries in mods/ as load failures.
    await fs.access(cachePath);

    // Remove existing link/file
    try {
      await fs.unlink(linkPath);
    } catch {
      // Doesn't exist yet
    }

    if (options.copyInsteadOfSymlink) {
      await fs.copyFile(cachePath, linkPath);
      return;
    }

    try {
      await fs.symlink(cachePath, linkPath);
    } catch (symlinkErr) {
      // Fallback: copy file (Windows without dev mode)
      console.warn(`Symlink failed, copying instead: ${symlinkErr.message}`);
      await fs.copyFile(cachePath, linkPath);
    }
  }

  /**
   * Sync all files for a profile: link cache entries to profile subdirectories.
   * items = array of { sha1, ext, file_name, category }
   */
  async syncProfileFiles(profileDir, items, options = {}) {
    const results = { linked: 0, failed: 0, errors: [], missing: [] };

    const purgeCategories = !!options.purgeCategories;
    const copyCategories = new Set(options.copyCategories || []);
    const categoriesToPurge = Array.isArray(options.categoriesToPurge)
      ? options.categoriesToPurge
      : Array.from(new Set((items || []).map((i) => i.category))).filter(Boolean);

    if (purgeCategories) {
      for (const category of categoriesToPurge) {
        const targetDir = path.join(profileDir, category);
        try {
          const entries = await fs.readdir(targetDir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(targetDir, entry.name);
            await fs.rm(entryPath, { recursive: true, force: true });
          }
        } catch {
          // Directory may not exist yet, that's fine.
        }
      }
    }

    for (const item of items) {
      try {
        await this.linkToProfile(item.category, item.sha1, item.ext, item.file_name, profileDir, {
          copyInsteadOfSymlink: copyCategories.has(item.category),
        });
        results.linked++;
      } catch (err) {
        results.failed++;
        results.errors.push(`${item.file_name}: ${err.message}`);
        results.missing.push(item.file_name);
      }
    }

    return results;
  }

  /**
   * Verify that one profile file is a symlink pointing to the expected cache file.
   */
  async verifyProfileSymlink(category, sha1, ext, fileName, profileDir) {
    const expectedCachePath = this.getCachePath(category, sha1, ext);
    const linkPath = path.join(profileDir, category, fileName);

    await fs.access(expectedCachePath);
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${fileName}: is not a symbolic link`);
    }

    const [resolvedLink, resolvedCache] = await Promise.all([
      fs.realpath(linkPath),
      fs.realpath(expectedCachePath),
    ]);

    if (resolvedLink !== resolvedCache) {
      throw new Error(`${fileName}: invalid symbolic link (unexpected target)`);
    }

    return true;
  }

  /**
   * Verify all profile links are valid symlinks to cache entries.
   */
  async verifyProfileSymlinks(profileDir, items) {
    const results = { verified: 0, failed: 0, errors: [] };

    for (const item of items) {
      try {
        await this.verifyProfileSymlink(item.category, item.sha1, item.ext, item.file_name, profileDir);
        results.verified++;
      } catch (err) {
        results.failed++;
        results.errors.push(`${item.file_name}: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Security check: every file in a profile category directory must be a symlink
   * resolving inside the corresponding cache category directory.
   */
  async verifyProfileDirectorySymlinkSecurity(category, profileDir) {
    const results = { checked: 0, failed: 0, errors: [] };
    const targetDir = path.join(profileDir, category);
    const cacheCategoryDir = this.categoryDirs[category];
    if (!cacheCategoryDir) {
      throw new Error(`Unknown cache category: ${category}`);
    }

    let entries = [];
    try {
      entries = await fs.readdir(targetDir, { withFileTypes: true });
    } catch {
      return results;
    }

    const normalizedCacheDir = await fs.realpath(cacheCategoryDir).catch(() => cacheCategoryDir);

    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;

      const entryPath = path.join(targetDir, entry.name);
      results.checked++;

      try {
        const stat = await fs.lstat(entryPath);
        if (!stat.isSymbolicLink()) {
          throw new Error('n\'est pas un symlink');
        }

        const resolved = await fs.realpath(entryPath);
        const rel = path.relative(normalizedCacheDir, resolved);
        const insideCache = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (!insideCache) {
          throw new Error('symlink pointe hors du cache');
        }
      } catch (err) {
        results.failed++;
        results.errors.push(`${entry.name}: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Clean orphaned cache entries that no profile references.
   * profilesDir = path to the profiles directory
   */
  async cleanOrphanedCache(profilesDir) {
    const referencedHashes = new Set();

    // Collect all sha1 references from all profiles
    const entries = await fs.readdir(profilesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const jsonPath = path.join(profilesDir, entry.name, 'profile.json');
        const raw = await fs.readFile(jsonPath, 'utf8');
        const profile = JSON.parse(raw);
        for (const mod of (profile.mods || [])) {
          if (mod.sha1) referencedHashes.add(mod.sha1);
        }
        for (const rp of (profile.resourcePacks || [])) {
          if (rp.sha1) referencedHashes.add(rp.sha1);
        }
        for (const sp of (profile.shaderPacks || [])) {
          if (sp.sha1) referencedHashes.add(sp.sha1);
        }
      } catch {
        // Skip broken profiles
      }
    }

    let removed = 0;

    // Check each category
    for (const [category, dir] of Object.entries(this.categoryDirs)) {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          // Extract sha1 from filename (sha1.ext)
          const sha1 = path.parse(file).name;
          if (!referencedHashes.has(sha1)) {
            await fs.unlink(path.join(dir, file));
            removed++;
          }
        }
      } catch {
        // Category dir might not exist
      }
    }

    return { removed };
  }

  async inspectStorage(profilesDir) {
    await this.init();
    const referenced = new Map();
    const cacheFiles = [];
    let profileBytes = 0;
    let profileCount = 0;

    const walkSize = async (root) => {
      let total = 0;
      let entries = [];
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return 0; }
      for (const entry of entries) {
        const filePath = path.join(root, entry.name);
        if (entry.isDirectory()) total += await walkSize(filePath);
        else if (entry.isFile()) total += (await fs.stat(filePath).catch(() => ({ size: 0 }))).size;
      }
      return total;
    };

    let profiles = [];
    try { profiles = await fs.readdir(profilesDir, { withFileTypes: true }); } catch {}
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue;
      profileCount += 1;
      profileBytes += await walkSize(path.join(profilesDir, entry.name));
      try {
        const profile = JSON.parse(await fs.readFile(path.join(profilesDir, entry.name, 'profile.json'), 'utf8'));
        for (const item of [...(profile.mods || []), ...(profile.resourcePacks || []), ...(profile.shaderPacks || [])]) {
          if (!item.sha1) continue;
          const key = String(item.sha1).toLowerCase();
          referenced.set(key, (referenced.get(key) || 0) + 1);
        }
      } catch {}
    }

    let cacheBytes = 0;
    let orphanBytes = 0;
    for (const [category, dir] of Object.entries(this.categoryDirs)) {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) continue;
        const hash = path.parse(entry.name).name.toLowerCase();
        const refs = referenced.get(hash) || 0;
        cacheBytes += stat.size;
        if (!refs) orphanBytes += stat.size;
        cacheFiles.push({ category, filePath, fileName: entry.name, sha1: hash, size: stat.size, references: refs });
      }
    }

    const deduplicatedBytes = cacheFiles.reduce((total, file) => total + Math.max(0, file.references - 1) * file.size, 0);
    return { profileCount, profileBytes, cacheBytes, orphanBytes, deduplicatedBytes, cacheFiles };
  }

  async verifyCache(profilesDir, onProgress) {
    const storage = await this.inspectStorage(profilesDir);
    const corrupt = [];
    let checked = 0;
    for (const file of storage.cacheFiles) {
      const actual = await this.computeFileSha1(file.filePath).catch(() => null);
      checked += 1;
      if (!actual || actual.toLowerCase() !== file.sha1) corrupt.push(file);
      onProgress?.({ checked, total: storage.cacheFiles.length, fileName: file.fileName });
    }
    return { checked, corrupt, valid: checked - corrupt.length };
  }
}

module.exports = { CacheManager };
