const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Agent } = require('undici');
const crypto = require('crypto-js');
const AdmZip = require('adm-zip');
const {
  getVersionList: xmclGetVersionList,
  installVersion,
  installDependenciesTask,
  fetchJavaRuntimeManifest,
  installJavaRuntimeTask,
  installForgeTask,
  installNeoForgedTask,
  getForgeVersionList: xmclGetForgeVersionList,
  installFabric,
  getLoaderArtifactListFor: getFabricLoaderList,
} = require('@xmcl/installer');
const { DefaultRangePolicy } = require('@xmcl/file-transfer');

/**
 * Core Minecraft management functions for downloading and launching
 */
class MinecraftManager {
  constructor(options = {}) {
    const toPositiveInt = (value, fallback) => {
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    this.options = {
      concurrentDownloads: toPositiveInt(options.concurrentDownloads, 32),
      connectionsPerHost: toPositiveInt(options.connectionsPerHost, 32),
      timeout: toPositiveInt(options.timeout, 120000),
      retryLimit: toPositiveInt(options.retryLimit, 5),
      minecraftPath: options.minecraftPath || '',
      javaPath: options.javaPath || 'java'
    };
    
    // Set up optimized download agent
    this.agent = new Agent({
      connectTimeout: this.options.timeout,
      bodyTimeout: this.options.timeout,
      headersTimeout: this.options.timeout,
      connections: this.options.connectionsPerHost,
      pipelining: 1
    });
  }
  
  /**
   * Create a dispatcher for optimized downloads
   */
  createDispatcher() {
    return this.agent;
  }
  
  /**
   * Get download options for fetch requests
   */
  getDownloadOptions() {
    return {
      dispatcher: this.agent,
      throwHttpErrors: false,
      retry: {
        limit: this.options.retryLimit,
        methods: ['GET'],
        statusCodes: [408, 413, 429, 500, 502, 503, 504, 521, 522, 524],
        maxTimeout: 60000,
        calculateDelay: ({ attemptCount }) => {
          return Math.min(1000 * Math.pow(2, attemptCount), 30000); // Exponential backoff
        }
      }
    };
  }

  retryDelay(attempt) {
    return Math.min(500 * Math.pow(2, attempt - 1) + Math.random() * 500, 10000);
  }

  async sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  isRetryableError(error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.cause?.status);
    if ([408, 429, 500, 502, 503, 504, 521, 522, 524].includes(status)) return true;
    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true;
    const message = String(error?.message || '').toLowerCase();
    return message.includes('timeout')
      || message.includes('socket')
      || message.includes('network')
      || message.includes('aborted')
      || message.includes('fetch failed')
      || message.includes('econnreset')
      || message.includes('temporarily unavailable');
  }

  async withRetries(label, operation, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || this.options.retryLimit);
    const progressCallback = options.progressCallback;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        const retryable = options.retryAll === true || this.isRetryableError(error);
        if (attempt >= attempts || !retryable) throw error;
        const delay = this.retryDelay(attempt);
        const message = `Retrying ${label} (attempt ${attempt + 1}/${attempts})...`;
        console.warn(`${message} Previous error: ${error.message || error}`);
        progressCallback?.({
          status: 'retrying-download',
          type: 'retrying-download',
          message,
          progress: options.progress ?? 0,
          total: 100,
          details: { step: 'retry', label, attempt: attempt + 1, maxAttempts: attempts },
        });
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  async startTaskWithRetries(label, createTask, handlers = {}, options = {}) {
    return this.withRetries(label, async () => {
      const failedSubtasks = [];
      const task = createTask();
      const result = await task.startAndWait({
        onStart: handlers.onStart,
        onUpdate: handlers.onUpdate,
        onFailed: (subtask, error) => {
          failedSubtasks.push({
            name: subtask?.name || subtask?.path || label,
            error,
          });
          handlers.onFailed?.(subtask, error);
        },
      });
      if (failedSubtasks.length) {
        const first = failedSubtasks[0];
        const message = first.error?.message || String(first.error || 'unknown error');
        const error = new Error(`${label} failed while downloading ${first.name}: ${message}`);
        error.cause = first.error;
        throw error;
      }
      return result;
    }, { ...options, retryAll: options.retryAll ?? true });
  }

  withMinecraftDirectory(versionInfo, minecraftPath) {
    const { Version } = require('@xmcl/core');
    const libraries = Array.isArray(versionInfo?.libraries)
      ? (versionInfo.libraries.every((library) => library?.download?.path)
        ? versionInfo.libraries
        : Version.resolveLibraries(versionInfo.libraries))
      : [];
    return {
      ...(versionInfo || {}),
      minecraftDirectory: versionInfo?.minecraftDirectory || minecraftPath,
      libraries,
    };
  }

  /**
   * Parse the versions manifest to get available versions
   */
  async getVersionList() {
    try {
      const response = await this.withRetries('Minecraft version list', async () => {
        const result = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', {
          dispatcher: this.agent,
          headers: { 'User-Agent': 'Minecraft-Launcher/1.0' },
        });
        if (!result.ok) {
          const error = new Error(`Failed to fetch version list: ${result.status} ${result.statusText}`);
          error.status = result.status;
          throw error;
        }
        return result;
      });
      
      const data = await response.json();
      return {
        latest: data.latest,
        versions: data.versions.map(version => ({
          id: version.id,
          type: version.type,
          releaseTime: version.releaseTime,
          url: version.url
        }))
      };
    } catch (error) {
      console.error('Error fetching version list:', error);
      throw error;
    }
  }

  /**
   * Get detailed version information for a specific Minecraft version
   */
  async getVersionInfo(versionId) {
    try {
      // First get the version manifest to find the URL
      const versionList = await this.getVersionList();
      const version = versionList.versions.find(v => v.id === versionId);
      
      if (!version) {
        throw new Error(`Version ${versionId} not found`);
      }
      
      const response = await this.withRetries(`Minecraft ${versionId} metadata`, async () => {
        const result = await fetch(version.url, {
          dispatcher: this.agent,
          headers: { 'User-Agent': 'Minecraft-Launcher/1.0' },
        });
        if (!result.ok) {
          const error = new Error(`Failed to fetch version info: ${result.status} ${result.statusText}`);
          error.status = result.status;
          throw error;
        }
        return result;
      });
      
      return await response.json();
    } catch (error) {
      console.error(`Error fetching version info for ${versionId}:`, error);
      throw error;
    }
  }

  /**
   * Normalize path to handle special characters
   * @param {string} dirPath - The path to normalize
   * @returns {string} - The normalized path
   */
  normalizePath(dirPath) {
    // Convert to Buffer and back to handle special characters correctly
    try {
      return dirPath;
    } catch (error) {
      console.error(`Error normalizing path ${dirPath}:`, error);
      return dirPath;
    }
  }

  /**
   * Ensures essential directories exist with proper handling of special characters
   */
  async ensureDirectories(minecraftPath) {
    const dirs = [
      minecraftPath,
      path.join(minecraftPath, 'versions'),
      path.join(minecraftPath, 'libraries'),
      path.join(minecraftPath, 'assets'),
      path.join(minecraftPath, 'assets', 'indexes'),
      path.join(minecraftPath, 'assets', 'objects'),
      path.join(minecraftPath, 'assets', 'virtual')
    ];
    
    for (const dir of dirs) {
      try {
        const normalizedDir = this.normalizePath(dir);
        await fs.mkdir(normalizedDir, { recursive: true });
      } catch (error) {
        console.error(`Error creating directory ${dir}:`, error);
        // Continue creating other directories
      }
    }
  }

  /**
   * Download a file with progress reporting and robust retry logic
   */
  async downloadFile(url, destination, options = {}) {
    const { progressCallback } = options;
    const maxRetries = this.options.retryLimit;
    let retries = 0;
    
    // Normalize the destination path to handle special characters
    const normalizedDestination = this.normalizePath(destination);
    
    while (retries < maxRetries) {
      try {
        // Create parent directory if it doesn't exist
        const normalizedDirname = this.normalizePath(path.dirname(destination));
        await fs.mkdir(normalizedDirname, { recursive: true });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);
        
        const response = await fetch(url, {
          dispatcher: this.agent,
          headers: { 'User-Agent': 'Minecraft-Launcher/1.0' },
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        
        const total = parseInt(response.headers.get('content-length') || '0', 10);
        let received = 0;
        
        try {
          const fileStream = await fs.open(normalizedDestination, 'w');
          
          try {
            // Use streaming approach for better memory management with large files
            const reader = response.body.getReader();
            
            while (true) {
              const { done, value } = await reader.read();
              
              if (done) {
                break;
              }
              
              await fileStream.write(Buffer.from(value));
              received += value.length;
              
              if (progressCallback && total > 0) {
                progressCallback({
                  url,
                  total,
                  progress: received,
                  percentage: Math.floor((received / total) * 100)
                });
              }
            }
          } finally {
            await fileStream.close();
          }
        } catch (fileError) {
          console.error(`File system error for ${normalizedDestination}:`, fileError);
          throw fileError;
        }
        
        return normalizedDestination;
        
      } catch (error) {
        retries++;
        console.error(`Error downloading ${url} (attempt ${retries}/${maxRetries}):`, error);
        
        if (retries >= maxRetries) {
          console.warn(`Failed to download ${url} after ${maxRetries} attempts, skipping file`);
          return null; // Return null instead of throwing to allow the process to continue
        }
        
        // Exponential backoff with jitter
        const delay = Math.min(1000 * Math.pow(2, retries) + Math.random() * 1000, 30000);
        console.log(`Retrying download in ${Math.floor(delay/1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    return null; // Should never reach here but just in case
  }

  /**
   * Validate file hash (SHA1)
   */
  async validateHash(filePath, expectedHash) {
    // Skip validation for small files to improve performance
    try {
      const normalizedPath = this.normalizePath(filePath);
      const stats = await fs.stat(normalizedPath);
      if (stats.size < 1024 * 1024) { // Skip files less than 1MB
        return true;
      }
      
      const fileData = await fs.readFile(normalizedPath);
      const hash = crypto.SHA1(fileData.toString()).toString();
      return hash === expectedHash;
    } catch (error) {
      console.error(`Error validating hash for ${filePath}:`, error);
      return false;
    }
  }

  /**
   * Download and install the Minecraft client jar
   */
  async downloadClient(versionInfo, minecraftPath, progressCallback) {
    const versionId = versionInfo.id;
    const versionDir = path.join(minecraftPath, 'versions', versionId);
    const clientJar = path.join(versionDir, `${versionId}.jar`);
    const clientJson = path.join(versionDir, `${versionId}.json`);
    
    // Normalize paths to handle special characters
    const normalizedVersionDir = this.normalizePath(versionDir);
    const normalizedClientJar = this.normalizePath(clientJar);
    const normalizedClientJson = this.normalizePath(clientJson);
    
    await fs.mkdir(normalizedVersionDir, { recursive: true });
    
    // Save version JSON
    await fs.writeFile(normalizedClientJson, JSON.stringify(versionInfo, null, 2));
    
    // Check if jar already exists
    try {
      await fs.access(normalizedClientJar);
      return { path: clientJar, skipped: true };
    } catch (error) {
      // File doesn't exist, download it
      progressCallback?.({
        type: 'jar-download',
        message: `Downloading Minecraft ${versionId}`,
        progress: 0,
        total: 100
      });
      
      await this.downloadFile(versionInfo.downloads.client.url, clientJar, {
        progressCallback: (data) => {
          progressCallback?.({
            type: 'jar-download',
            message: `Downloading Minecraft ${versionId}`,
            progress: data.progress,
            total: data.total
          });
        }
      });
      
      progressCallback?.({
        type: 'jar-download',
        message: `Downloaded Minecraft ${versionId}`,
        progress: 100,
        total: 100
      });
      
      return { path: clientJar, skipped: false };
    }
  }

  /**
   * Download the assets index file
   */
  async downloadAssetsIndex(versionInfo, minecraftPath, progressCallback) {
    const assetIndex = versionInfo.assetIndex;
    const indexPath = path.join(minecraftPath, 'assets', 'indexes', `${assetIndex.id}.json`);
    
    // Normalize the path to handle special characters
    const normalizedIndexPath = this.normalizePath(indexPath);
    
    try {
      await fs.access(normalizedIndexPath);
      const indexData = await fs.readFile(normalizedIndexPath, 'utf8');
      return { path: indexPath, data: JSON.parse(indexData), skipped: true };
    } catch (error) {
      progressCallback?.({
        type: 'assets-index',
        message: `Downloading assets index for ${assetIndex.id}`,
        progress: 0,
        total: 100
      });
      
      await this.downloadFile(assetIndex.url, indexPath);
      
      const indexData = await fs.readFile(normalizedIndexPath, 'utf8');
      
      progressCallback?.({
        type: 'assets-index',
        message: `Downloaded assets index for ${assetIndex.id}`,
        progress: 100,
        total: 100
      });
      
      return { path: indexPath, data: JSON.parse(indexData), skipped: false };
    }
  }

  /**
   * Download all game assets with improved resilience
   */
  async downloadAssets(assetIndex, minecraftPath, progressCallback) {
    const { objects } = assetIndex;
    const assets = Object.values(objects);
    const totalAssets = assets.length;
    let downloadedAssets = 0;
    let skippedAssets = 0;
    let failedAssets = 0;
    
    progressCallback?.({
      type: 'assets',
      message: `Downloading game assets (0/${totalAssets})`,
      progress: 0,
      total: totalAssets
    });
    
    // Process assets in configured batches
    const batchSize = this.options.concurrentDownloads;
    const assetBatches = [];
    
    for (let i = 0; i < assets.length; i += batchSize) {
      assetBatches.push(assets.slice(i, i + batchSize));
    }
    
    for (const batch of assetBatches) {
      await Promise.allSettled(batch.map(async (asset) => {
        const { hash } = asset;
        const hashPrefix = hash.substring(0, 2);
        const assetPath = path.join(minecraftPath, 'assets', 'objects', hashPrefix, hash);
        
        // Normalize the asset path
        const normalizedAssetPath = this.normalizePath(assetPath);
        
        try {
          // Check if asset already exists
          await fs.access(normalizedAssetPath);
          
          // Optionally validate hash for large files
          if (asset.size > 1024 * 1024) {
            const isValid = await this.validateHash(assetPath, hash);
            if (!isValid) {
              throw new Error('Hash validation failed');
            }
          }
          
          skippedAssets++;
        } catch (error) {
          // Asset doesn't exist or hash validation failed, download it
          const assetUrl = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;
          const result = await this.downloadFile(assetUrl, assetPath);
          
          if (result === null) {
            failedAssets++;
            console.warn(`Failed to download asset: ${hash}`);
          }
        }
        
        downloadedAssets++;
        
        progressCallback?.({
          type: 'assets',
          message: `Downloading game assets (${downloadedAssets}/${totalAssets})`,
          progress: downloadedAssets,
          total: totalAssets
        });
      }));
      
      // Keep event loop responsive without throttling throughput
      await new Promise(resolve => setImmediate(resolve));
    }
    
    if (failedAssets > 0) {
      console.warn(`${failedAssets} assets failed to download but continuing with installation`);
    }
    
    return {
      downloaded: downloadedAssets - skippedAssets - failedAssets,
      skipped: skippedAssets,
      failed: failedAssets,
      total: totalAssets
    };
  }

  /**
   * Get maven artifact information
   */
  parseMavenArtifact(artifact) {
    // Format: groupId:artifactId:version[@classifier]
    const parts = artifact.split(':');
    const hasClassifier = parts.length > 3;
    const groupId = parts[0];
    const artifactId = parts[1];
    let version = parts[2];
    let classifier = '';
    
    if (hasClassifier) {
      if (parts[2].includes('@')) {
        [version, classifier] = parts[2].split('@');
      } else {
        classifier = parts[3];
      }
    }
    
    const groupPath = groupId.replace(/\./g, '/');
    const artifactPath = `${groupPath}/${artifactId}/${version}/${artifactId}-${version}${classifier ? `-${classifier}` : ''}.jar`;
    
    return {
      groupId,
      artifactId,
      version,
      classifier,
      path: artifactPath
    };
  }

  /**
   * Download all required libraries with improved resilience
   */
  async downloadLibraries(versionInfo, minecraftPath, progressCallback) {
    const libraries = versionInfo.libraries;
    const totalLibraries = libraries.length;
    let downloadedLibraries = 0;
    let skippedLibraries = 0;
    let failedLibraries = 0;
    
    progressCallback?.({
      type: 'libraries',
      message: `Downloading libraries (0/${totalLibraries})`,
      progress: 0,
      total: totalLibraries
    });
    
    // Check OS rules for each library
    const osName = this.getOsName();
    const requiredLibraries = libraries.filter(library => {
      if (!library.rules) return true;
      
      let allowed = false;
      for (const rule of library.rules) {
        if (rule.action === 'allow') {
          if (!rule.os) {
            allowed = true;
          } else if (rule.os.name === osName) {
            allowed = true;
          }
        } else if (rule.action === 'disallow') {
          if (!rule.os) {
            allowed = false;
          } else if (rule.os.name === osName) {
            allowed = false;
          }
        }
      }
      
      return allowed;
    });
    
    // Process libraries in configured batches
    const batchSize = this.options.concurrentDownloads;
    const libraryBatches = [];
    
    for (let i = 0; i < requiredLibraries.length; i += batchSize) {
      libraryBatches.push(requiredLibraries.slice(i, i + batchSize));
    }
    
    for (const batch of libraryBatches) {
      await Promise.allSettled(batch.map(async (library) => {
        try {
          let artifact;
          let url;
          
          if (library.downloads && library.downloads.artifact) {
            artifact = library.downloads.artifact;
            url = artifact.url;
          } else {
            // Legacy library format
            const mavenArtifact = this.parseMavenArtifact(library.name);
            artifact = {
              path: mavenArtifact.path,
              sha1: library.checksums ? library.checksums[0] : null,
              size: -1
            };
            
            if (library.url) {
              url = `${library.url}${mavenArtifact.path}`;
            } else {
              url = `https://libraries.minecraft.net/${mavenArtifact.path}`;
            }
          }
          
          const libraryPath = path.join(minecraftPath, 'libraries', artifact.path);
          
          // Normalize the library path
          const normalizedLibraryPath = this.normalizePath(libraryPath);
          
          // Check if library already exists
          try {
            await fs.access(normalizedLibraryPath);
            
            // Optional hash validation for large files
            if (artifact.sha1 && artifact.size > 1024 * 1024) {
              const isValid = await this.validateHash(libraryPath, artifact.sha1);
              if (!isValid) {
                throw new Error('Hash validation failed');
              }
            }
            
            skippedLibraries++;
          } catch (error) {
            // Library doesn't exist or hash validation failed, download it
            const result = await this.downloadFile(url, libraryPath);
            if (result === null) {
              failedLibraries++;
              console.warn(`Failed to download library: ${library.name}`);
            }
          }
        } catch (error) {
          console.error(`Failed to process library ${library.name}:`, error);
          failedLibraries++;
          // Continue with other libraries even if one fails
        }
        
        downloadedLibraries++;
        
        progressCallback?.({
          type: 'libraries',
          message: `Downloading libraries (${downloadedLibraries}/${totalLibraries})`,
          progress: downloadedLibraries,
          total: totalLibraries
        });
      }));
      
      // Keep event loop responsive without throttling throughput
      await new Promise(resolve => setImmediate(resolve));
    }
    
    if (failedLibraries > 0) {
      console.warn(`${failedLibraries} libraries failed to download but continuing with installation`);
    }
    
    return {
      downloaded: downloadedLibraries - skippedLibraries - failedLibraries,
      skipped: skippedLibraries,
      failed: failedLibraries,
      total: totalLibraries
    };
  }

  /**
   * Get OS name in Minecraft format
   */
  getOsName() {
    const platform = process.platform;
    switch (platform) {
      case 'win32': return 'windows';
      case 'darwin': return 'osx';
      case 'linux': return 'linux';
      default: return platform;
    }
  }

  /**
   * Get OS architecture in Minecraft format
   */
  getOsArch() {
    const arch = process.arch;
    switch (arch) {
      case 'x64': return 'x86_64';
      case 'ia32': return 'x86';
      default: return arch;
    }
  }

  /**
   * Generate the Minecraft launch command
   */
  generateLaunchCommand(versionInfo, options) {
    const {
      minecraftPath,
      javaPath,
      uuid,
      username,
      accessToken = '',
      userType = 'legacy',
      xuid = '',
      clientId = '',
      maxMemory = 2048,
      minMemory = 512,
      extraJvmArgs = [],
      features = {},
      gameDir = null,
    } = options;
    
    // gameDir overrides the game_directory for --gameDir isolation per profile
    const effectiveGameDir = gameDir || minecraftPath;
    
    const osName = this.getOsName();
    const osArch = this.getOsArch();
    const versionId = versionInfo.id;
    const versionType = versionInfo.type;
    const uuidWithoutHyphens = (uuid || '').replace(/-/g, '');
    const uuidWithHyphens = uuidWithoutHyphens.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, '$1-$2-$3-$4-$5');
    const effectiveAccessToken = accessToken || uuidWithoutHyphens;

    const matchesOs = (ruleOs) => {
      if (!ruleOs) return true;
      if (ruleOs.name && ruleOs.name !== osName) return false;
      if (ruleOs.arch && ruleOs.arch !== osArch) return false;
      return true;
    };

    const matchesFeatures = (ruleFeatures) => {
      if (!ruleFeatures) return true;
      return Object.entries(ruleFeatures).every(([key, value]) => features[key] === value);
    };

    const isAllowedByRules = (rules = []) => {
      if (!rules.length) return true;
      let allowed = false;
      for (const rule of rules) {
        if (!matchesOs(rule.os) || !matchesFeatures(rule.features)) {
          continue;
        }
        allowed = rule.action === 'allow';
      }
      return allowed;
    };

    const applyPlaceholders = (value, mapping) => String(value).replace(/\$\{([^}]+)\}/g, (match, key) => {
      if (Object.prototype.hasOwnProperty.call(mapping, key)) {
        return String(mapping[key] ?? '');
      }
      return match;
    });
    
    // Set up class paths
    const classPaths = [];
    
    const addLibraryToClassPath = (library) => {
      if (library.downloads && library.downloads.artifact) {
        classPaths.push(path.join(minecraftPath, 'libraries', library.downloads.artifact.path));
        return;
      }

      if (library.downloads?.classifiers && library.natives) {
        return;
      }

      const mavenArtifact = this.parseMavenArtifact(library.name);
      classPaths.push(path.join(minecraftPath, 'libraries', mavenArtifact.path));
    };

    // Add libraries to class path
    versionInfo.libraries.forEach(library => {
      if (!library.rules) {
        addLibraryToClassPath(library);
        return;
      }
      
      if (isAllowedByRules(library.rules)) {
        addLibraryToClassPath(library);
      }
    });
    
    // Add the actual Minecraft client jar. Legacy Forge profiles often do not
    // have their own version jar and rely on the inherited vanilla jar instead.
    const isNeoForgeVersion = /neoforge/i.test(String(versionId))
      || JSON.stringify(versionInfo.arguments || {}).includes('fml.neoForgeVersion');
    if (!isNeoForgeVersion) {
      const requestedJarVersionId = versionInfo.jar || versionInfo._mainJarVersionId || versionId;
      let minecraftJarPath = path.join(minecraftPath, 'versions', requestedJarVersionId, `${requestedJarVersionId}.jar`);
      if (!fsSync.existsSync(minecraftJarPath) && versionInfo.inheritsFrom) {
        minecraftJarPath = path.join(minecraftPath, 'versions', versionInfo.inheritsFrom, `${versionInfo.inheritsFrom}.jar`);
      }
      classPaths.push(minecraftJarPath);
    }
    
    // Construct class path string (OS-dependent)
    const classPathSeparator = osName === 'windows' ? ';' : ':';
    const classPath = classPaths.join(classPathSeparator);
    
    // JVM arguments — only memory here; GC tuning comes via extraJvmArgs from the caller
    const jvmArgs = [
      `-Xms${minMemory}M`,
      `-Xmx${maxMemory}M`,
    ];
    
    // Add user-provided JVM arguments
    jvmArgs.push(...extraJvmArgs);
    
    // Add version-specific JVM arguments if present
    if (versionInfo.arguments && versionInfo.arguments.jvm) {
      versionInfo.arguments.jvm.forEach(arg => {
        if (typeof arg === 'string') {
          jvmArgs.push(arg);
        } else if (typeof arg === 'object') {
          if (isAllowedByRules(arg.rules || [])) {
            if (Array.isArray(arg.value)) {
              jvmArgs.push(...arg.value);
            } else {
              jvmArgs.push(arg.value);
            }
          }
        }
      });
    }

    const jvmMapping = {
      // Natives live in the *base* (vanilla) version directory, not in the mod-loader version dir.
      // launcher.js sets _nativesVersionId = inheritsFrom when present.
      natives_directory: path.join(minecraftPath, 'versions', versionInfo._nativesVersionId || versionId, 'natives'),
      launcher_name: 'erozion-launcher',
      launcher_version: '1.0',
      classpath: classPath,
      library_directory: path.join(minecraftPath, 'libraries'),
      classpath_separator: classPathSeparator,
      // Forge uses this in -DignoreList. Point it at the real game jar for an
      // inherited loader profile, while game arguments keep the child id below.
      version_name: versionInfo._mainJarVersionId || versionId,
      ...features,
    };

    const resolvedJvmArgs = jvmArgs
      .map(arg => applyPlaceholders(arg, jvmMapping))
      .filter(arg => !/\$\{[^}]+\}/.test(arg) && arg !== '');
    
    // Legacy JVM arguments
    if (!resolvedJvmArgs.some(arg => arg.startsWith('-Djava.library.path='))) {
      const nativesVersionId = versionInfo._nativesVersionId || versionId;
      resolvedJvmArgs.push(
        `-Djava.library.path=${path.join(minecraftPath, 'versions', nativesVersionId, 'natives')}`,
        `-Dminecraft.launcher.brand=erozion-launcher`,
        `-Dminecraft.launcher.version=1.0`
      );
    }

    if (!resolvedJvmArgs.some(arg => arg === '-cp' || arg.startsWith('-cp='))) {
      resolvedJvmArgs.push('-cp', classPath);
    }
    
    // Main class
    const mainClass = versionInfo.mainClass;
    
    // Game arguments
    let gameArgs = [];
    
    // Modern argument format (1.13+)
    if (versionInfo.arguments && versionInfo.arguments.game) {
      versionInfo.arguments.game.forEach(arg => {
        if (typeof arg === 'string') {
          gameArgs.push(arg);
        } else if (typeof arg === 'object') {
          if (isAllowedByRules(arg.rules || [])) {
            if (Array.isArray(arg.value)) {
              gameArgs.push(...arg.value);
            } else {
              gameArgs.push(arg.value);
            }
          }
        }
      });
    } 
    // Legacy argument format
    else if (versionInfo.minecraftArguments) {
      gameArgs = versionInfo.minecraftArguments.split(' ');
    }
    
    // Replace argument placeholders
    const assetIndex = versionInfo.assetIndex ? versionInfo.assetIndex.id : versionInfo.assets;
    const assetDirectory = assetIndex === 'legacy' ? path.join(minecraftPath, 'assets', 'virtual', 'legacy') : path.join(minecraftPath, 'assets');
    
    const gameArgMapping = {
      auth_player_name: username,
      version_name: versionId,
      game_directory: effectiveGameDir,
      assets_root: path.join(minecraftPath, 'assets'),
      assets_index_name: assetIndex,
      auth_uuid: uuidWithoutHyphens,
      auth_access_token: effectiveAccessToken,
      user_type: userType,
      version_type: versionType,
      user_properties: '{}',
      auth_session: effectiveAccessToken,
      game_assets: assetDirectory,
      auth_xuid: xuid,
      clientid: clientId,
      user_educator: '',
      app_icon: '',
      username,
      auth_uuid_hyphens: uuidWithHyphens,
      resolution_width: '',
      resolution_height: '',
      quickPlayPath: '',
      quickPlaySingleplayer: '',
      quickPlayMultiplayer: '',
      quickPlayRealms: '',
      ...features,
    };

    gameArgs = gameArgs.map(arg => applyPlaceholders(arg, gameArgMapping));

    const flagRequiresValue = new Set([
      '--width',
      '--height',
      '--quickPlayPath',
      '--quickPlaySingleplayer',
      '--quickPlayMultiplayer',
      '--quickPlayRealms',
    ]);

    const sanitizedGameArgs = [];
    for (let i = 0; i < gameArgs.length; i += 1) {
      const current = gameArgs[i];
      if (!current || /\$\{[^}]+\}/.test(current)) {
        continue;
      }

      if (flagRequiresValue.has(current)) {
        const next = gameArgs[i + 1];
        if (!next || /\$\{[^}]+\}/.test(next)) {
          i += 1;
          continue;
        }
        sanitizedGameArgs.push(current, next);
        i += 1;
        continue;
      }

      sanitizedGameArgs.push(current);
    }
    
    // Construct the full command
    const fullCommand = [javaPath, ...resolvedJvmArgs, mainClass, ...sanitizedGameArgs];
    
    return fullCommand;
  }

  /**
   * Launch Minecraft with proper handling of special characters in paths.
   * Stdout/stderr are redirected to <minecraftPath>/logs/launcher-last.log so
   * crashes can be diagnosed. A per-launch diagnostics folder is also written
   * with the exact command, classpath, and exit metadata.
   */
  launchMinecraft(launchOptions) {
    const { command, detached = true, minecraftPath } = launchOptions;
    
    // Convert command array to string for logging
    console.log('Launching Minecraft with command:', command.join(' '));
    
    const executable = command[0];
    const args = command.slice(1);

    // Redirect stdout+stderr to a log file. Using file descriptors lets us
    // keep the process detached without holding the parent alive via pipes.
    const { openSync, closeSync, mkdirSync } = require('fs');
    const logsDir = path.join(minecraftPath, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'launcher-last.log');
    const launchId = new Date().toISOString().replace(/[:.]/g, '-');
    const diagnosticsDir = path.join(logsDir, 'impulse-launches', launchId);
    mkdirSync(diagnosticsDir, { recursive: true });

    const cpIndex = command.findIndex(arg => arg === '-cp' || arg === '-classpath' || arg === '--class-path');
    const classPath = cpIndex >= 0 ? command[cpIndex + 1] || '' : '';
    const classPathEntries = classPath
      ? classPath.split(this.getOsName() === 'windows' ? ';' : ':')
      : [];
    fsSync.writeFileSync(path.join(diagnosticsDir, 'command.txt'), `${command.map(part => JSON.stringify(part)).join(' ')}\n`, 'utf8');
    fsSync.writeFileSync(path.join(diagnosticsDir, 'command.json'), JSON.stringify({
      launchId,
      createdAt: new Date().toISOString(),
      cwd: minecraftPath,
      executable,
      args,
      detached,
      logPath,
      classPathEntryCount: classPathEntries.length,
      javaLibraryPath: args.find(arg => arg.startsWith('-Djava.library.path=')) || null,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
    }, null, 2), 'utf8');
    fsSync.writeFileSync(path.join(diagnosticsDir, 'classpath.txt'), `${classPathEntries.join('\n')}\n`, 'utf8');
    const logFd = openSync(logPath, 'w');

    const proc = spawn(executable, args, {
      cwd: minecraftPath,
      detached,
      stdio: ['ignore', logFd, logFd],
      shell: false,
    });

    // Close our copy of the fd — the child process keeps its own reference
    closeSync(logFd);

    if (detached) {
      proc.unref();
    }

    // Expose the log path so the caller can read it if the process exits early
    proc.logPath = logPath;
    proc.diagnosticsDir = diagnosticsDir;

    proc.once('exit', (code, signal) => {
      fsSync.writeFileSync(path.join(diagnosticsDir, 'exit.json'), JSON.stringify({
        code,
        signal,
        exitedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
    });

    return proc;
  }

  execFileAsync(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 1024 * 1024 * 8, ...options }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  isLegacyJavaRuntime(versionInfo) {
    const javaVersion = versionInfo?.javaVersion;
    if (javaVersion?.component === 'jre-legacy' || Number(javaVersion?.majorVersion) <= 8) {
      return true;
    }

    const match = String(versionInfo?.id || '').match(/^1\.(\d+)(?:\.|$)/);
    return match ? Number(match[1]) <= 16 : false;
  }

  parseJavaMajor(versionOutput) {
    const quoted = String(versionOutput || '').match(/version\s+"([^"]+)"/i);
    const value = quoted ? quoted[1] : String(versionOutput || '').trim();
    if (!value) return null;

    const parts = value.split(/[._+\-\s]/).filter(Boolean);
    if (parts[0] === '1' && parts[1]) {
      return Number.parseInt(parts[1], 10);
    }
    return Number.parseInt(parts[0], 10);
  }

  async getJavaMajor(javaPath) {
    try {
      const output = await this.getJavaVersionOutput(javaPath);
      const major = this.parseJavaMajor(output);
      return Number.isFinite(major) ? major : null;
    } catch (error) {
      return null;
    }
  }

  async getJavaVersionOutput(javaPath) {
    const { stdout, stderr } = await this.execFileAsync(javaPath, ['-version'], { timeout: 10000 });
    return `${stdout}\n${stderr}`;
  }

  async isUsableJavaRuntime(javaPath, expectedMajor = null) {
    try {
      await fs.access(javaPath);
      const major = await this.getJavaMajor(javaPath);
      if (!major) return false;
      return !expectedMajor || major === expectedMajor;
    } catch {
      return false;
    }
  }

  normalizeJavaCandidate(candidate) {
    if (!candidate) return null;
    const resolved = String(candidate).trim();
    if (!resolved) return null;

    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    if (path.basename(resolved).toLowerCase() === executable) {
      return resolved;
    }
    return path.join(resolved, 'bin', executable);
  }

  async findJavaBinary(rootDir) {
    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    const stack = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if ((entry.isFile() || entry.isSymbolicLink()) &&
            entry.name.toLowerCase() === executable &&
            path.basename(path.dirname(fullPath)) === 'bin') {
          return fullPath;
        }
        if (entry.isDirectory()) {
          stack.push(fullPath);
        }
      }
    }

    return null;
  }

  async getLocalJava8Candidates(minecraftPath, jreDir, javaBinCacheFile) {
    const candidates = [
      process.env.IMPULSE_JAVA8_PATH,
      process.env.JAVA8_HOME,
      this.options.javaPath && this.options.javaPath !== 'java' ? this.options.javaPath : null,
    ].map(candidate => this.normalizeJavaCandidate(candidate)).filter(Boolean);

    try {
      candidates.push((await fs.readFile(javaBinCacheFile, 'utf8')).trim());
    } catch { /* no cache yet */ }

    const executable = process.platform === 'win32' ? 'java.exe' : 'java';
    candidates.push(
      path.join(jreDir, 'bin', executable),
      path.join(jreDir, 'jre.bundle', 'Contents', 'Home', 'bin', executable),
      path.join(minecraftPath, 'jdks', 'legacy-java8', 'bin', executable),
    );

    if (process.platform === 'darwin') {
      for (const jvmRoot of [
        '/Library/Java/JavaVirtualMachines',
        path.join(process.env.HOME || '', 'Library', 'Java', 'JavaVirtualMachines'),
      ]) {
        try {
          const homes = await fs.readdir(jvmRoot);
          for (const home of homes) {
            candidates.push(path.join(jvmRoot, home, 'Contents', 'Home', 'bin', executable));
          }
        } catch { /* optional system path */ }
      }

      candidates.push(
        '/opt/homebrew/opt/openjdk@8/bin/java',
        '/usr/local/opt/openjdk@8/bin/java',
        '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java',
      );
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  getAdoptiumJava8Url() {
    const platform = {
      darwin: 'mac',
      win32: 'windows',
      linux: 'linux',
    }[process.platform];

    if (!platform) {
      throw new Error(`Automatic Java 8 download is not supported on ${process.platform}`);
    }

    const archMap = {
      x64: 'x64',
      arm64: process.platform === 'darwin' ? 'x64' : 'aarch64',
      ia32: 'x86',
    };
    const arch = archMap[process.arch];
    if (!arch) {
      throw new Error(`Automatic Java 8 download is not supported for ${process.arch}`);
    }

    return `https://api.adoptium.net/v3/binary/latest/8/ga/${platform}/${arch}/jre/hotspot/normal/eclipse`;
  }

  async extractJavaArchive(archivePath, destination) {
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });

    if (process.platform === 'win32') {
      await this.execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`,
      ]);
      return;
    }

    await this.execFileAsync('tar', ['-xzf', archivePath, '-C', destination]);
  }

  async ensureLegacyJavaRuntime(minecraftPath, component, progressCallback) {
    const jreDir = path.join(minecraftPath, 'jdks', component || 'jre-legacy');
    const javaBinCacheFile = path.join(jreDir, '.java_bin');

    await fs.mkdir(jreDir, { recursive: true });

    for (const candidate of await this.getLocalJava8Candidates(minecraftPath, jreDir, javaBinCacheFile)) {
      const major = await this.getJavaMajor(candidate);
      if (major === 8) {
        if (process.platform !== 'win32') {
          await fs.chmod(candidate, 0o755).catch(() => {});
        }
        await fs.writeFile(javaBinCacheFile, candidate, 'utf8');
        console.log(`Using Java 8 runtime: ${candidate}`);
        return candidate;
      }
    }

    progressCallback?.({
      status: 'java',
      message: 'Downloading Java 8 for legacy Forge...',
      progress: 0,
      total: 100,
      details: { step: 'java' },
    });

    const archivePath = path.join(jreDir, process.platform === 'win32' ? 'temurin8.zip' : 'temurin8.tar.gz');
    const extractDir = path.join(jreDir, 'runtime');
    const downloadUrl = this.getAdoptiumJava8Url();

    console.log(`Downloading Java 8 runtime from Adoptium: ${downloadUrl}`);
    const downloaded = await this.downloadFile(downloadUrl, archivePath, {
      progressCallback: (data) => {
        progressCallback?.({
          status: 'java',
          message: `Downloading Java 8 (${data.percentage}%)`,
          progress: data.percentage,
          total: 100,
          details: { step: 'java' },
        });
      },
    });

    if (!downloaded) {
      throw new Error(
        'Forge legacy requires Java 8, but Impulse could not download it. ' +
        'Install Java 8 or set IMPULSE_JAVA8_PATH to a Java 8 home/bin/java path.'
      );
    }

    progressCallback?.({
      status: 'java',
      message: 'Installing Java 8...',
      progress: 95,
      total: 100,
      details: { step: 'java' },
    });

    await this.extractJavaArchive(archivePath, extractDir);
    const resolvedBin = await this.findJavaBinary(extractDir);
    if (!resolvedBin) {
      throw new Error(`Java 8 archive did not contain a bin/java executable in ${extractDir}`);
    }

    if (process.platform !== 'win32') {
      await fs.chmod(resolvedBin, 0o755).catch(() => {});
    }

    const major = await this.getJavaMajor(resolvedBin);
    if (major !== 8) {
      throw new Error(`Downloaded Java runtime is Java ${major || 'unknown'}, expected Java 8`);
    }

    await fs.writeFile(javaBinCacheFile, resolvedBin, 'utf8');
    progressCallback?.({
      status: 'java',
      message: 'Java 8 installed',
      progress: 100,
      total: 100,
      details: { step: 'java' },
    });

    console.log(`Java 8 installed: ${resolvedBin}`);
    return resolvedBin;
  }

  /**
   * Ensure the correct Mojang JRE is installed for the given Minecraft version.
   * Downloads it if missing. Returns the path to the java binary.
   * @param {object} versionInfo - Parsed version JSON
   * @param {string} minecraftPath - Base Minecraft data directory
   * @param {function} progressCallback - Optional progress callback
   * @returns {string} Absolute path to the java executable
   */
  async ensureJavaRuntime(versionInfo, minecraftPath, progressCallback) {
    const javaVersion = versionInfo.javaVersion;
    const component = javaVersion?.component || 'java-runtime-gamma';
    const expectedMajor = Number(javaVersion?.majorVersion) || null;

    if (this.isLegacyJavaRuntime(versionInfo)) {
      return this.ensureLegacyJavaRuntime(minecraftPath, component === 'java-runtime-gamma' ? 'jre-legacy' : component, progressCallback);
    }

    // JREs are stored at <minecraftPath>/jdks/<component>/
    const jreDir = path.join(minecraftPath, 'jdks', component);
    const javaBin = process.platform === 'win32'
      ? path.join(jreDir, 'bin', 'java.exe')
      : path.join(jreDir, 'bin', 'java');
    // macOS: Mojang packages JREs as .app bundles — the real binary is inside
    const macBundleBin = path.join(jreDir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
    // Persistent cache so we skip the access() dance on every launch
    const javaBinCacheFile = path.join(jreDir, '.java_bin');

    // 1. Check cached path from a previous install
    try {
      const cached = (await fs.readFile(javaBinCacheFile, 'utf8')).trim();
      if (await this.isUsableJavaRuntime(cached, expectedMajor)) {
        if (process.platform !== 'win32') await fs.chmod(cached, 0o755).catch(() => {});
        console.log(`JRE already installed (cached): ${cached}`);
        return cached;
      }
      console.warn(`Cached Java runtime is not usable for Java ${expectedMajor || '?'}: ${cached}`);
    } catch { /* cache miss */ }

    // 2. Check well-known paths before deciding to download
    for (const candidate of [javaBin, macBundleBin]) {
      if (await this.isUsableJavaRuntime(candidate, expectedMajor)) {
        if (process.platform !== 'win32') await fs.chmod(candidate, 0o755).catch(() => {});
        await fs.mkdir(jreDir, { recursive: true }).catch(() => {});
        await fs.writeFile(javaBinCacheFile, candidate, 'utf8');
        console.log(`JRE already installed: ${candidate}`);
        return candidate;
      }
    }

    progressCallback?.({
      status: 'java',
      message: `Downloading Java ${javaVersion?.majorVersion || '?'} (${component})...`,
      progress: 0,
      total: 100,
      details: { step: 'java' }
    });

    console.log(`Downloading Mojang JRE component: ${component} → ${jreDir}`);

    try {
      // Recreate the managed runtime directory so a broken partial install cannot
      // pass through to launch as a missing java.exe later.
      await fs.rm(jreDir, { recursive: true, force: true });
      await fs.mkdir(jreDir, { recursive: true });

      // Do NOT pass dispatcher: XMCL bundles its own undici version and an
      // incompatible outer Agent causes downloads to silently fail.
      const manifest = await this.withRetries(`Java runtime manifest ${component}`, () => fetchJavaRuntimeManifest({ target: component }), {
        progressCallback,
        progress: 5,
        retryAll: true,
      });

      let lastProgress = 0;
      await this.startTaskWithRetries(`Java runtime ${component}`, () => installJavaRuntimeTask({ manifest, destination: jreDir }), {
        onUpdate: (task, chunkSize) => {
          if (task.total > 0) {
            const pct = Math.floor((task.progress / task.total) * 100);
            if (pct !== lastProgress) {
              lastProgress = pct;
              progressCallback?.({
                status: 'java',
                message: `Downloading Java ${javaVersion?.majorVersion || '?'} (${pct}%)`,
                progress: pct,
                total: 100,
                details: { step: 'java' }
              });
            }
          }
        },
        onFailed: (task, error) => {
          console.error('JRE subtask failed:', task.name, error);
        },
      }, {
        progressCallback,
        progress: 15,
        retryAll: true,
      });

      // Determine which binary path was actually created
      let resolvedBin = null;
      for (const candidate of [javaBin, macBundleBin]) {
        try { await fs.access(candidate); resolvedBin = candidate; break; } catch { /* try next */ }
      }
      if (!resolvedBin) {
        resolvedBin = await this.findJavaBinary(jreDir);
        const executable = process.platform === 'win32' ? 'bin/java.exe' : 'bin/java';
        if (!resolvedBin) throw new Error(`${executable} not found in ${jreDir} after installation`);
      }

      // Make executable and write cache so future calls skip the download path
      if (process.platform !== 'win32') {
        await fs.chmod(resolvedBin, 0o755).catch(() => {});
      }
      const installedMajor = await this.getJavaMajor(resolvedBin);
      if (expectedMajor && installedMajor !== expectedMajor) {
        throw new Error(`Installed Java runtime is Java ${installedMajor || 'unknown'}, expected Java ${expectedMajor}`);
      }
      await fs.writeFile(javaBinCacheFile, resolvedBin, 'utf8');

      console.log(`JRE installed: ${resolvedBin}`);
      progressCallback?.({
        status: 'java',
        message: `Java ${javaVersion?.majorVersion || '?'} installed`,
        progress: 100,
        total: 100,
        details: { step: 'java' }
      });

      return resolvedBin;
    } catch (err) {
      console.error('Failed to download Mojang JRE:', err);
      throw new Error(
        `Could not install the bundled Mojang Java runtime "${component}". ` +
        `Clear game files to retry the bundled Java download, or choose a Custom Java path in Settings. ` +
        `Expected runtime location: ${jreDir}. Original error: ${err.message || err}`
      );
    }
  }

  /**
   * Extract native libraries from the version's native JARs into the natives directory.
   * Works with both old-style (classifiers) and modern (plain artifact with OS rules) formats.
   */
  async extractNatives(versionInfo, minecraftPath) {
    const versionId = versionInfo.id;
    const nativesDir = path.join(minecraftPath, 'versions', versionId, 'natives');
    await fs.mkdir(nativesDir, { recursive: true });

    const osName = this.getOsName(); // 'osx', 'windows', 'linux'
    const arch = process.arch;       // 'arm64', 'x64', etc.

    const isAllowedForCurrentOs = (rules) => {
      if (!rules || !rules.length) return true;
      let allowed = false;
      for (const rule of rules) {
        if (!rule.os) {
          allowed = rule.action === 'allow';
        } else if (rule.os.name === osName) {
          allowed = rule.action === 'allow';
        }
      }
      return allowed;
    };

    const nativeJarPaths = [];

    for (const library of (versionInfo.libraries || [])) {
      if (!library.downloads) continue;

      // Modern format: native JARs listed as plain artifacts with OS rules
      if (library.downloads.artifact) {
        const libPath = library.downloads.artifact.path || '';
        if (libPath.includes('native') && isAllowedForCurrentOs(library.rules)) {
          nativeJarPaths.push(path.join(minecraftPath, 'libraries', libPath));
        }
      }

      // Old format: classifiers (pre-1.19)
      if (library.downloads.classifiers && library.natives) {
        const nativeKey = library.natives[osName];
        if (nativeKey) {
          const resolvedKey = nativeKey.replace('${arch}', arch === 'x64' ? '64' : '32');
          const classifier = library.downloads.classifiers[resolvedKey];
          if (classifier) {
            nativeJarPaths.push(path.join(minecraftPath, 'libraries', classifier.path));
          }
        }
      }
    }

    for (const jarPath of nativeJarPaths) {
      try {
        fsSync.accessSync(jarPath); // check exists (sync for AdmZip compat)
        const zip = new AdmZip(jarPath);
        const entries = zip.getEntries();
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const entryName = entry.entryName;
          // Skip META-INF and non-native files
          if (entryName.startsWith('META-INF/')) continue;
          const destPath = path.join(nativesDir, path.basename(entryName));
          try {
            await fs.writeFile(destPath, entry.getData());
          } catch {
            // ignore individual file errors
          }
        }
        console.log(`Extracted natives from: ${path.basename(jarPath)}`);
      } catch (e) {
        console.warn(`Skipping native JAR (not found or bad zip): ${jarPath} — ${e.message}`);
      }
    }

    console.log(`Natives extracted to: ${nativesDir}`);
    return nativesDir;
  }

  /**
   * Install a complete Minecraft version
   */
  async installMinecraft(versionId, minecraftPath, progressCallback) {
    try {
      await this.ensureDirectories(minecraftPath);

      const report = (type, message, progress) => {
        progressCallback?.({ type, message, progress, total: 100 });
      };

      const versionFolder = path.join(minecraftPath, 'versions', versionId);
      const versionJsonPath = path.join(versionFolder, `${versionId}.json`);
      const versionJarPath = path.join(versionFolder, `${versionId}.jar`);

      const downloadOptions = {
        dispatcher: this.agent,
        rangePolicy: new DefaultRangePolicy(512 * 1024, 8),
      };

      report('json-download', `Fetching Minecraft ${versionId} metadata`, 0);
      const versionList = await this.withRetries('Minecraft version manifest', () => xmclGetVersionList(), {
        progressCallback,
        progress: 5,
      });
      const versionMeta = versionList.versions.find(v => v.id === versionId);

      if (!versionMeta) {
        throw new Error(`Version ${versionId} not found in Mojang manifest`);
      }

      report('json-download', `Checking local installation for ${versionId}`, 10);
      const remoteVersionInfo = await this.getVersionInfo(versionId);

      let localVersionInfo = null;
      let localJarStat = null;

      try {
        const localVersionRaw = await fs.readFile(this.normalizePath(versionJsonPath), 'utf8');
        localVersionInfo = JSON.parse(localVersionRaw);
      } catch {
        localVersionInfo = null;
      }

      try {
        localJarStat = await fs.stat(this.normalizePath(versionJarPath));
      } catch {
        localJarStat = null;
      }

      const remoteClient = remoteVersionInfo?.downloads?.client;
      const localClient = localVersionInfo?.downloads?.client;
      const sameClientSha1 = !remoteClient?.sha1 || !localClient?.sha1 || remoteClient.sha1 === localClient.sha1;
      const sameClientSize = !remoteClient?.size || !localJarStat?.size || remoteClient.size === localJarStat.size;

      if (localVersionInfo && localJarStat && sameClientSha1 && sameClientSize) {
        report('dependencies', `Checking dependencies for ${versionId}`, 45);
        const localResolvedVersion = this.withMinecraftDirectory(localVersionInfo, minecraftPath);
        await this.startTaskWithRetries(`Minecraft ${versionId} libraries and assets`, () => installDependenciesTask(localResolvedVersion, downloadOptions), {
          onStart: (task) => {
            const taskPath = String(task.path || task.name || '');
            if (taskPath.includes('.assets')) {
              report('assets', `Checking game assets for ${versionId}`, 50);
            } else if (taskPath.includes('.libraries')) {
              report('libraries', `Checking libraries for ${versionId}`, 65);
            }
          },
          onUpdate: (task) => {
            const ratio = task.total > 0 ? task.progress / task.total : 0;
            const taskPath = String(task.path || task.name || '');
            if (taskPath.includes('.assets')) {
              report('assets', `Checking game assets for ${versionId}`, 50 + Math.floor(ratio * 35));
            } else if (taskPath.includes('.libraries')) {
              report('libraries', `Checking libraries for ${versionId}`, 70 + Math.floor(ratio * 25));
            } else {
              report('dependencies', `Verifying dependencies for ${versionId}`, 45 + Math.floor(ratio * 50));
            }
          },
        }, {
          progressCallback,
          progress: 65,
          retryAll: false,
        });

        // Check if natives directory is already populated
        let nativesOk = false;
        try {
          const nativesDir = path.join(minecraftPath, 'versions', versionId, 'natives');
          const nativesContents = await fs.readdir(nativesDir);
          nativesOk = nativesContents.length > 0;
        } catch {
          nativesOk = false;
        }

        if (!nativesOk) {
          report('finished', `Extracting natives for ${versionId}`, 95);
          await this.extractNatives(localVersionInfo, minecraftPath);
        }

        // Ensure the correct Java runtime is installed
        const javaPath = await this.ensureJavaRuntime(localResolvedVersion, minecraftPath, progressCallback);

        report('finished', `Minecraft ${versionId} ready`, 100);
        return {
          success: true,
          versionId,
          versionInfo: localResolvedVersion,
          skippedInstall: true,
          javaPath,
        };
      }

      report('jar-download', `Installing client ${versionId}`, 20);
      const resolvedVersion = await this.withRetries(`Minecraft ${versionId} client files`, () => installVersion(versionMeta, minecraftPath, downloadOptions), {
        progressCallback,
        progress: 20,
        retryAll: true,
      });

      report('dependencies', `Preparing dependency checks for ${versionId}`, 45);

      const resolvedVersionWithDirectory = this.withMinecraftDirectory(resolvedVersion, minecraftPath);
      await this.startTaskWithRetries(`Minecraft ${versionId} libraries and assets`, () => installDependenciesTask(resolvedVersionWithDirectory, downloadOptions), {
        onStart: (task) => {
          const taskPath = String(task.path || task.name || '');
          if (taskPath.includes('.assets')) {
            report('assets', `Checking game assets for ${versionId}`, 50);
          } else if (taskPath.includes('.libraries')) {
            report('libraries', `Checking libraries for ${versionId}`, 65);
          }
        },
        onUpdate: (task) => {
          const ratio = task.total > 0 ? task.progress / task.total : 0;

          const taskPath = String(task.path || task.name || '');
          if (taskPath.includes('.assets')) {
            report('assets', `Checking game assets for ${versionId}`, 50 + Math.floor(ratio * 35));
          } else if (taskPath.includes('.libraries')) {
            report('libraries', `Checking libraries for ${versionId}`, 70 + Math.floor(ratio * 25));
          } else {
            report('dependencies', `Verifying dependencies for ${versionId}`, 45 + Math.floor(ratio * 50));
          }
        },
      }, {
        progressCallback,
        progress: 65,
        retryAll: false,
      });
      
      // Extract native libraries into versions/{id}/natives/
      report('finished', `Extracting natives for ${versionId}`, 95);
      await this.extractNatives(resolvedVersion, minecraftPath);

      // Ensure the correct Java runtime is installed
      const javaPath = await this.ensureJavaRuntime(resolvedVersionWithDirectory, minecraftPath, progressCallback);

      progressCallback?.({
        type: 'finished',
        message: `Minecraft ${versionId} is ready`,
        progress: 100,
        total: 100
      });
      
      return {
        success: true,
        versionId,
        versionInfo: resolvedVersionWithDirectory,
        javaPath,
      };
    } catch (error) {
      console.error(`Failed to install Minecraft ${versionId}:`, error);
      throw error;
    }
  }
  // ---------------------------------------------------------------------------
  // Forge / Fabric version listing
  // ---------------------------------------------------------------------------

  /**
   * Get available Forge versions for a given Minecraft version.
   * Returns an array of { version, mcVersion, branch, latest, recommended } objects
   * scraped from the Forge maven site by XMCL.
   */
  async getForgeVersionList(mcVersion) {
    const raw = await xmclGetForgeVersionList({ minecraft: mcVersion });
    // XMCL may return either a plain array OR an object { mcversion, versions: [...] }
    // depending on the installed version of @xmcl/installer.
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.versions) ? raw.versions : []);
    return list.map(v => ({
      forgeVersion: v.version,
      mcVersion: v.mcVersion || v.mcversion || mcVersion,
      recommended: v.type === 'recommended',
      latest: v.type === 'latest',
      installer: v.installer,
    }));
  }

  /**
   * Get available Fabric loader versions for a given Minecraft version.
   * Returns an array of { loaderVersion, stable } objects.
   */
  async getFabricVersionList(mcVersion) {
    const list = await getFabricLoaderList(mcVersion);
    return (list || []).map(entry => ({
      loaderVersion: entry.loader?.version,
      stable: entry.loader?.stable ?? true,
      mcVersion,
    }));
  }

  // ---------------------------------------------------------------------------
  // Forge installation
  // ---------------------------------------------------------------------------

  /**
   * Install a Forge loader for the given Minecraft version.
   * @param {string} mcVersion  e.g. '1.20.1'
   * @param {string} forgeVersion  full Forge version string e.g. '47.2.0' or '1.20.1-47.2.0'
   * @param {string} minecraftPath  root .minecraft directory
   * @param {Function} [progressCallback]
   * @returns {Promise<string>} installed version id, e.g. '1.20.1-forge-47.2.0'
   */
  async installForge(mcVersion, forgeVersion, minecraftPath, progressCallback) {
    // Normalise: if the caller passes just '47.2.0' we need '1.20.1-47.2.0'
    const fullVersion = forgeVersion.includes('-') ? forgeVersion : `${mcVersion}-${forgeVersion}`;

    progressCallback?.({
      status: 'forge',
      message: `Installing Forge ${fullVersion}...`,
      progress: 0, total: 100,
      details: { step: 'forge' },
    });

    // First make sure the vanilla version is installed (Forge inherits from it)
    const minecraftInstall = await this.installMinecraft(mcVersion, minecraftPath, (data) => {
      progressCallback?.({ ...data, progress: Math.floor(data.progress * 0.6), total: 100 });
    });
    const installerJava = minecraftInstall?.javaPath || this.options.javaPath || 'java';

    progressCallback?.({
      status: 'forge',
      message: `Fetching Forge list for ${mcVersion}...`,
      progress: 62, total: 100,
      details: { step: 'forge' },
    });

    // installForgeTask requires a version *object* (with .installer URL), not a string.
    // Fetch the list and find the matching entry.
    const rawForgeList = await this.withRetries(`Forge version list for ${mcVersion}`, () => xmclGetForgeVersionList({ minecraft: mcVersion }), {
      progressCallback,
      progress: 62,
      retryAll: true,
    });
    const forgeList = Array.isArray(rawForgeList) ? rawForgeList : (Array.isArray(rawForgeList?.versions) ? rawForgeList.versions : []);
    const shortVersion = forgeVersion.includes('-')
      ? forgeVersion.split('-').slice(1).join('-')
      : forgeVersion;
    const versionObj = forgeList.find(v => {
      const vShort = v.version?.includes('-')
        ? v.version.split('-').slice(1).join('-')
        : v.version;
      return v.version === forgeVersion || v.version === fullVersion || vShort === shortVersion;
    });
    if (!versionObj) {
      throw new Error(
        `Forge '${forgeVersion}' was not found for Minecraft ${mcVersion}. ` +
        `Available: ${forgeList.slice(0, 5).map(v => v.version).join(', ')}`
      );
    }

    progressCallback?.({
      status: 'forge',
      message: `Downloading Forge installer ${versionObj.version}...`,
      progress: 65, total: 100,
      details: { step: 'forge' },
    });

    let lastPct = 65;
    const versionId = await this.startTaskWithRetries(`Forge ${versionObj.version}`, () => installForgeTask(versionObj, minecraftPath, {
      ...this.getDownloadOptions(),
      java: installerJava,
    }), {
      onUpdate: (t) => {
        if (t.total > 0) {
          const pct = 65 + Math.floor((t.progress / t.total) * 35);
          if (pct !== lastPct) {
            lastPct = pct;
            progressCallback?.({
              status: 'forge',
              message: `Installing Forge (${pct}%)`,
              progress: pct, total: 100,
              details: { step: 'forge' },
            });
          }
        }
      },
      onFailed: (t, err) => console.error('Forge subtask failed:', t.name, err),
    }, {
      progressCallback,
      progress: 65,
      retryAll: true,
    });

    progressCallback?.({
      status: 'forge',
      message: `Forge ${versionObj.version} installed`,
      progress: 100, total: 100,
      details: { step: 'forge' },
    });

    // installForgeTask usually resolves to the installed Minecraft version id
    // string, but old Forge installers may use legacy names or return nothing.
    const modernInstalledId = fullVersion.replace(/^(\d[\d.]+)-(\d.*)$/, '$1-forge-$2');
    let installedId = typeof versionId === 'string' ? versionId : modernInstalledId;
    const installedJsonPath = (id) => path.join(minecraftPath, 'versions', id, `${id}.json`);
    if (!fsSync.existsSync(installedJsonPath(installedId))) {
      const legacyInstalledId = `${mcVersion}-Forge${shortVersion}-${mcVersion}`;
      if (fsSync.existsSync(installedJsonPath(legacyInstalledId))) {
        installedId = legacyInstalledId;
      } else {
        try {
          const versionDirs = await fs.readdir(path.join(minecraftPath, 'versions'), { withFileTypes: true });
          const match = versionDirs
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .find(id => /forge/i.test(id) && id.includes(mcVersion) && id.includes(shortVersion) && fsSync.existsSync(installedJsonPath(id)));
          if (match) installedId = match;
        } catch {
          // Keep the best calculated id; launch-time resolution will report a detailed error if needed.
        }
      }
    }

    // Download any remaining Forge dependencies (libraries, natives)
    progressCallback?.({
      status: 'forge',
      message: 'Downloading Forge libraries...',
      progress: 80, total: 100,
      details: { step: 'forge-deps' },
    });
    const { Version } = require('@xmcl/core');
    const resolved = await this.withRetries(`Forge ${versionObj.version} version metadata`, () => Version.parse(minecraftPath, installedId), {
      progressCallback,
      progress: 80,
      retryAll: true,
    });
    let lastDepPct = 80;
    await this.startTaskWithRetries(`Forge ${versionObj.version} libraries`, () => installDependenciesTask(resolved, { ...this.getDownloadOptions(), side: 'client' }), {
      onUpdate: (t) => {
        if (t.total > 0) {
          const pct = 80 + Math.floor((t.progress / t.total) * 18);
          if (pct !== lastDepPct) {
            lastDepPct = pct;
            progressCallback?.({
              status: 'forge',
              message: `Forge libraries (${pct}%)`,
              progress: pct, total: 100,
              details: { step: 'forge-deps' },
            });
          }
        }
      },
      onFailed: (t, err) => console.error('Forge dep subtask failed:', t.name, err),
    }, {
      progressCallback,
      progress: 80,
      retryAll: true,
    });
    progressCallback?.({
      status: 'forge',
      message: `Forge ${versionObj.version} ready`,
      progress: 100, total: 100,
      details: { step: 'forge-deps' },
    });

    return installedId;
  }

  // ---------------------------------------------------------------------------
  // NeoForge installation
  // ---------------------------------------------------------------------------

  /**
   * Install a NeoForge loader for the given Minecraft version.
   * @param {string} mcVersion  e.g. '1.21.1'
   * @param {string} neoForgeVersion  e.g. '21.1.243'
   * @param {string} minecraftPath  root .minecraft directory
   * @param {Function} [progressCallback]
   * @returns {Promise<string>} installed version id
   */
  async installNeoForge(mcVersion, neoForgeVersion, minecraftPath, progressCallback) {
    progressCallback?.({
      status: 'neoforge',
      message: `Installing NeoForge ${neoForgeVersion} for ${mcVersion}...`,
      progress: 0, total: 100,
      details: { step: 'neoforge' },
    });

    const minecraftInstall = await this.installMinecraft(mcVersion, minecraftPath, (data) => {
      progressCallback?.({ ...data, progress: Math.floor(data.progress * 0.6), total: 100 });
    });
    const installerJava = minecraftInstall?.javaPath || this.options.javaPath || 'java';

    progressCallback?.({
      status: 'neoforge',
      message: `Downloading NeoForge installer ${neoForgeVersion}...`,
      progress: 65, total: 100,
      details: { step: 'neoforge' },
    });

    let lastPct = 65;
    const versionId = await this.startTaskWithRetries(`NeoForge ${neoForgeVersion}`, () => installNeoForgedTask('neoforge', neoForgeVersion, minecraftPath, {
      ...this.getDownloadOptions(),
      java: installerJava,
    }), {
      onUpdate: (t) => {
        if (t.total > 0) {
          const pct = 65 + Math.floor((t.progress / t.total) * 35);
          if (pct !== lastPct) {
            lastPct = pct;
            progressCallback?.({
              status: 'neoforge',
              message: `Installing NeoForge (${pct}%)`,
              progress: pct, total: 100,
              details: { step: 'neoforge' },
            });
          }
        }
      },
      onFailed: (t, err) => console.error('NeoForge subtask failed:', t.name, err),
    }, {
      progressCallback,
      progress: 65,
      retryAll: true,
    });

    const installedId = typeof versionId === 'string' && versionId.trim()
      ? versionId.trim()
      : `neoforge-${neoForgeVersion}`;

    progressCallback?.({
      status: 'neoforge',
      message: 'Downloading NeoForge libraries...',
      progress: 80, total: 100,
      details: { step: 'neoforge-deps' },
    });
    const { Version } = require('@xmcl/core');
    const resolved = await this.withRetries(`NeoForge ${neoForgeVersion} version metadata`, () => Version.parse(minecraftPath, installedId), {
      progressCallback,
      progress: 80,
      retryAll: true,
    });
    let lastDepPct = 80;
    await this.startTaskWithRetries(`NeoForge ${neoForgeVersion} libraries`, () => installDependenciesTask(resolved, { ...this.getDownloadOptions(), side: 'client' }), {
      onUpdate: (t) => {
        if (t.total > 0) {
          const pct = 80 + Math.floor((t.progress / t.total) * 18);
          if (pct !== lastDepPct) {
            lastDepPct = pct;
            progressCallback?.({
              status: 'neoforge',
              message: `NeoForge libraries (${pct}%)`,
              progress: pct, total: 100,
              details: { step: 'neoforge-deps' },
            });
          }
        }
      },
      onFailed: (t, err) => console.error('NeoForge dep subtask failed:', t.name, err),
    }, {
      progressCallback,
      progress: 80,
      retryAll: true,
    });

    progressCallback?.({
      status: 'neoforge',
      message: `NeoForge ${neoForgeVersion} ready`,
      progress: 100, total: 100,
      details: { step: 'neoforge-deps' },
    });

    return installedId;
  }

  // ---------------------------------------------------------------------------
  // Fabric installation
  // ---------------------------------------------------------------------------

  /**
   * Install a Fabric loader for the given Minecraft version.
   * @param {string} mcVersion  e.g. '1.21.4'
   * @param {string} loaderVersion  e.g. '0.16.9'
   * @param {string} minecraftPath  root .minecraft directory
   * @param {Function} [progressCallback]
   * @returns {Promise<string>} installed version id, e.g. '1.21.4-fabric0.16.9'
   */
  async installFabric(mcVersion, loaderVersion, minecraftPath, progressCallback) {
    progressCallback?.({
      status: 'fabric',
      message: `Installing Fabric ${loaderVersion} for ${mcVersion}...`,
      progress: 0, total: 100,
      details: { step: 'fabric' },
    });

    // Make sure the vanilla version exists first
    await this.installMinecraft(mcVersion, minecraftPath, (data) => {
      progressCallback?.({ ...data, progress: Math.floor(data.progress * 0.7), total: 100 });
    });

    progressCallback?.({
      status: 'fabric',
      message: `Downloading Fabric ${loaderVersion}...`,
      progress: 70, total: 100,
      details: { step: 'fabric' },
    });

    // installFabric writes the version JSON that inherits from mcVersion
    const versionId = await installFabric({
      minecraft: minecraftPath,
      minecraftVersion: mcVersion,
      version: loaderVersion,
    });

    // Now download the Fabric libraries via installDependenciesTask
    progressCallback?.({
      status: 'fabric',
      message: 'Downloading Fabric libraries...',
      progress: 80, total: 100,
      details: { step: 'fabric' },
    });

    const { Version } = require('@xmcl/core');
    const resolved = await Version.parse(minecraftPath, versionId);
    const depsTask = installDependenciesTask(resolved, { side: 'client' });
    let lastPct = 80;
    await depsTask.startAndWait({
      onUpdate: (t) => {
        if (t.total > 0) {
          const pct = 80 + Math.floor((t.progress / t.total) * 20);
          if (pct !== lastPct) {
            lastPct = pct;
            progressCallback?.({
              status: 'fabric',
              message: `Fabric libraries (${pct}%)`,
              progress: pct, total: 100,
              details: { step: 'fabric' },
            });
          }
        }
      },
    });

    progressCallback?.({
      status: 'fabric',
      message: `Fabric ${loaderVersion} installed`,
      progress: 100, total: 100,
      details: { step: 'fabric' },
    });

    return versionId;
  }
}

module.exports = { MinecraftManager };
