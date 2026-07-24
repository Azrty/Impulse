/// <reference types="vite/client" />

import type { LaunchProgress, MinecraftAccount, SavedServer, User } from './types';

declare global {
  interface Window {
    api?: {
      offlineLogin: (username: string) => Promise<{ success: boolean; error?: string; user?: User }>;
      microsoftLogin: () => Promise<{ success: boolean; error?: string; user?: User; account?: MinecraftAccount }>;
      getCurrentUser: () => Promise<{ success: boolean; error?: string; user?: User }>;
      logout: () => Promise<{ success: boolean }>;
      getMinecraftAccounts: () => Promise<MinecraftAccount[]>;
      setActiveMinecraftAccount: (accountId: string) => Promise<{ success: boolean; error?: string; user?: User }>;
      removeMinecraftAccount: (accountId: string) => Promise<{ success: boolean; error?: string; accounts?: MinecraftAccount[] }>;

      listServers: () => Promise<SavedServer[]>;
      addServer: (payload: { address: string; manifestPort?: number }) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      refreshServer: (serverId: string) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      removeServer: (serverId: string) => Promise<{ success: boolean; servers?: SavedServer[] }>;
      launchServer: (serverId: string) => Promise<{ success: boolean; error?: string }>;

      getLauncherSettings: () => Promise<{
        minecraftPath: string;
        javaPath: string | null;
        minMemory: number;
        maxMemory: number;
        downloadSettings: {
          concurrentDownloads: number;
          connectionsPerHost: number;
          timeout: number;
        };
      }>;
      updateLauncherSettings: (settings: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;

      onLaunchProgress: (callback: (data: LaunchProgress) => void) => () => void;
      onLaunched: (callback: (data: { serverId: string; message: string; logPath?: string; diagnosticsDir?: string }) => void) => () => void;
      onLaunchError: (callback: (data: { serverId?: string; error: string; logPath?: string; diagnosticsDir?: string }) => void) => () => void;
      onGameClosed: (callback: (data: { serverId: string; code: number; logPath?: string; diagnosticsDir?: string }) => void) => () => void;

      checkForUpdates: () => Promise<void>;
      downloadUpdate: () => Promise<void>;
      installUpdate: () => Promise<void>;
      getAppVersion: () => Promise<string>;
      onUpdateStatus: (callback: (data: {
        status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error';
        startup?: boolean;
        version?: string;
        message?: string;
        percent?: number;
        bytesPerSecond?: number;
        transferred?: number;
        total?: number;
      }) => void) => () => void;

      minimizeWindow: () => void;
      maximizeWindow: () => void;
      closeWindow: () => void;
      isElectron: boolean;
      platform: string;
    };
  }
}

export {};
