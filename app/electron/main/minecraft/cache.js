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
  async downloadAndStore(category, url, sha1, ext, dispatcher) {
    await this.init();

    // If we already have this hash, skip download
    if (sha1 && await this.hasFile(category, sha1, ext)) {
      return { sha1, cached: true };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const fetchOpts = { signal: controller.signal, ...(dispatcher ? { dispatcher } : {}) };
    let response;
    try {
      response = await fetch(url, fetchOpts);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText} for ${url}`);
      }

      var buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Download timed out after 60s for ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
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
      throw new Error(`${fileName}: n'est pas un symlink`);
    }

    const [resolvedLink, resolvedCache] = await Promise.all([
      fs.realpath(linkPath),
      fs.realpath(expectedCachePath),
    ]);

    if (resolvedLink !== resolvedCache) {
      throw new Error(`${fileName}: symlink invalide (cible inattendue)`);
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
}

module.exports = { CacheManager };
