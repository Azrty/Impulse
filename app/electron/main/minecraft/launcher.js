const { MinecraftManager } = require('./core');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

/**
 * Minecraft Launcher implementation
 */
class MinecraftLauncher {
  constructor(options = {}) {
    this.manager = new MinecraftManager(options);
    this.options = options;
  }
  
  /**
   * Get list of all available Minecraft versions
   */
  async getVersionList() {
    return await this.manager.getVersionList();
  }
  
  /**
   * Check if a specific version is already installed
   */
  async isVersionInstalled(minecraftPath, versionId) {
    try {
      const versionFolder = path.join(minecraftPath, 'versions', versionId);
      const versionJson = path.join(versionFolder, `${versionId}.json`);
      const versionJar = path.join(versionFolder, `${versionId}.jar`);
      
      // Normalize paths to handle special characters
      const normalizedVersionJson = this.manager.normalizePath(versionJson);
      const normalizedVersionJar = this.manager.normalizePath(versionJar);
      
      try {
        await fs.access(normalizedVersionJson);
        await fs.access(normalizedVersionJar);
        return true;
      } catch {
        return false;
      }
    } catch (error) {
      console.error(`Error checking if version ${versionId} is installed:`, error);
      return false;
    }
  }
  
  /**
   * Download and install Minecraft
   */
  async installMinecraft(options) {
    const { 
      version, 
      minecraftPath,
      progressCallback
    } = options;
    
    if (!version) {
      throw new Error('Version cannot be null! Please specify a Minecraft version.');
    }

    progressCallback?.({
      status: 'installing',
      message: 'Checking installed files and updates...',
      progress: 0,
      total: 100
    });

    return await this.manager.installMinecraft(version, minecraftPath, (data) => {
      let progress = 0;
      let message = data.message;
      let step = 'preparing';
      let substep = null;

      switch (data.type || data.status) {
        case 'java':
          progress = typeof data.progress === 'number' ? data.progress : 5;
          step = 'java';
          substep = null;
          break;
        case 'json-download':
          progress = typeof data.progress === 'number' ? data.progress : 10;
          step = 'metadata';
          substep = 'version';
          break;
        case 'jar-download':
          progress = typeof data.progress === 'number' ? data.progress : 35;
          step = 'game';
          substep = 'client';
          break;
        case 'dependencies':
          progress = typeof data.progress === 'number' ? data.progress : 55;
          step = 'dependencies';
          substep = 'verify';
          break;
        case 'assets':
          progress = typeof data.progress === 'number' ? data.progress : 75;
          step = 'assets';
          substep = 'objects';
          break;
        case 'libraries':
          progress = typeof data.progress === 'number' ? data.progress : 85;
          step = 'libraries';
          substep = null;
          break;
        case 'finished':
          progress = 100;
          step = 'complete';
          break;
        default:
          progress = 50;
          break;
      }

      progressCallback?.({
        status: 'installing',
        message,
        progress,
        total: 100,
        details: {
          percentage: progress,
          step,
          substep
        }
      });
    });
  }
  
  /**
   * Launch Minecraft
   */
  async launchMinecraft(options) {
    const {
      version,
      minecraftPath,
      javaRuntime = 'auto',
      javaPath: explicitJavaPath,
      username,
      uuid = uuidv4(),
      accessToken = '',
      userType = 'legacy',
      xuid = '',
      clientId = '',
      maxMemory = 2048,
      minMemory = 1024,
      extraJvmArgs = [],
      detached = true,
      gameDir = null,
      serverAddress = null,
      serverPort = null,
      progressCallback = null,
    } = options;
    
    // Get version metadata
    const versionJsonPath = path.join(minecraftPath, 'versions', version, `${version}.json`);
    
    try {
      const normalizedVersionJsonPath = this.manager.normalizePath(versionJsonPath);
      let versionData = JSON.parse(await fs.readFile(normalizedVersionJsonPath, 'utf8'));

      // If this version inherits from another (Forge, Fabric, etc.), merge the parent JSON.
      // Without this merge the vanilla game args (--username, --uuid, --accessToken …)
      // and JVM args (natives_directory, logging, etc.) are missing from the launch command.
      if (versionData.inheritsFrom) {
        const parentId = versionData.inheritsFrom;
        const parentJsonPath = path.join(minecraftPath, 'versions', parentId, `${parentId}.json`);
        try {
          const parentData = JSON.parse(await fs.readFile(this.manager.normalizePath(parentJsonPath), 'utf8'));

          // Merge libraries: child (Forge/Fabric) takes precedence over parent
          // (vanilla), but keep duplicate parent coordinates because legacy
          // vanilla JSONs use OS rules across repeated LWJGL entries.
          const childLibs  = versionData.libraries || [];
          const parentLibs = parentData.libraries  || [];
          const libKey = (lib) => {
            // lib.name is a Maven coordinate like "com.google.guava:guava:32.1.2-jre"
            const parts = (lib.name || '').split(':');
            return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : lib.name;
          };
          const childKeys = new Set(childLibs.map(libKey));
          const dedupedParent = parentLibs.filter((lib) => !childKeys.has(libKey(lib)));
          versionData.libraries = [...dedupedParent, ...childLibs];

          // Merge arguments (modern format: { game: [...], jvm: [...] })
          if (parentData.arguments) {
            if (!versionData.arguments) versionData.arguments = {};
            // Game args: parent (--username, --uuid …) then child (--launchTarget …)
            if (parentData.arguments.game) {
              versionData.arguments.game = [
                ...(parentData.arguments.game || []),
                ...(versionData.arguments.game || []),
              ];
            }
            // JVM args: parent (${natives_directory}, logging …) then child
            if (parentData.arguments.jvm) {
              versionData.arguments.jvm = [
                ...(parentData.arguments.jvm || []),
                ...(versionData.arguments.jvm || []),
              ];
            }
          }

          // Legacy minecraftArguments (1.12 and older)
          if (parentData.minecraftArguments && !versionData.minecraftArguments) {
            versionData.minecraftArguments = parentData.minecraftArguments;
          }

          // Inherit fields that the child JSON omits
          if (!versionData.assetIndex)  versionData.assetIndex  = parentData.assetIndex;
          if (!versionData.assets)      versionData.assets      = parentData.assets;
          if (!versionData.javaVersion) versionData.javaVersion = parentData.javaVersion;
          if (!versionData.type)        versionData.type        = parentData.type;
          // Natives live in the PARENT (vanilla) version directory
          versionData._nativesVersionId = parentId;
        } catch (parentErr) {
          console.warn(`Could not load parent version JSON (${parentId}):`, parentErr.message);
          // Fall through — we'll still try, just with potentially missing args
          versionData._nativesVersionId = version;
        }
      } else {
        versionData._nativesVersionId = version;
      }

      const javaResolution = await this.resolveJavaRuntime({
        javaRuntime,
        explicitJavaPath,
        versionData,
        minecraftPath,
        progressCallback,
      });
      const javaPath = javaResolution.javaPath;
      
      // Generate launch command
      const launchCommand = this.manager.generateLaunchCommand(versionData, {
        minecraftPath,
        javaPath,
        uuid,
        username,
        accessToken,
        userType,
        xuid,
        clientId,
        maxMemory,
        minMemory,
        extraJvmArgs,
        gameDir,
      });

      // Append server auto-connect args if provided
      if (serverAddress) {
        launchCommand.push('--server', serverAddress);
        if (serverPort && serverPort !== 25565) {
          launchCommand.push('--port', String(serverPort));
        }
      }
      
      // Launch the game - use gameDir as cwd if specified
      return this.manager.launchMinecraft({
        command: launchCommand,
        minecraftPath: gameDir || minecraftPath,
        detached
      });
    } catch (error) {
      console.error('Failed to launch Minecraft:', error);
      throw error;
    }
  }

  async resolveJavaRuntime({ javaRuntime, explicitJavaPath, versionData, minecraftPath, progressCallback }) {
    const mode = ['auto', 'custom'].includes(String(javaRuntime)) ? String(javaRuntime) : 'auto';

    if (mode === 'custom') {
      return {
        javaPath: await this.resolveCustomJavaPath(explicitJavaPath),
        mode,
      };
    }

    return {
      javaPath: await this.manager.ensureJavaRuntime(versionData, minecraftPath, progressCallback),
      mode,
    };
  }

  async resolveCustomJavaPath(explicitJavaPath) {
    const explicitJava = String(explicitJavaPath || '').trim();
    if (!explicitJava) throw new Error('Java Runtime is set to Custom, but no Java path is configured.');
    const bareJavaCommands = process.platform === 'win32' ? ['java', 'java.exe'] : ['java'];
    const javaPath = bareJavaCommands.includes(explicitJava.toLowerCase())
      ? explicitJava
      : this.manager.normalizeJavaCandidate(explicitJava);
    const isBareCommand = bareJavaCommands.includes(String(javaPath).toLowerCase());
    if (!isBareCommand) {
      try {
        await fs.access(javaPath);
      } catch {
        throw new Error(`Configured Java executable was not found: ${javaPath}`);
      }
    } else if (!await this.manager.getJavaMajor(javaPath)) {
      throw new Error(`Configured Java command was not found on PATH: ${javaPath}`);
    }
    return javaPath;
  }
}

module.exports = { MinecraftLauncher };
