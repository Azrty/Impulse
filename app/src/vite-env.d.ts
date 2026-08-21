/// <reference types="vite/client" />

import type { CrashReport, CrashShareStatus, DiscordRpcSettings, GameStorage, ImpulseInvitation, LaunchProgress, MinecraftAccount, OfflineDetails, RepairReport, RunningGame, SavedServer, User } from './types';

declare global {
  interface Window {
    api?: {
      getLegalConsent: () => Promise<{ accepted: boolean; requiredVersion: string; acceptedAt: string | null; privacyUrl: string; termsUrl: string }>;
      acceptLegalConsent: (payload: { privacyAccepted: boolean; termsAccepted: boolean }) => Promise<{ success: boolean; error?: string; accepted?: boolean; requiredVersion?: string }>;
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
      offlineLogin: (username: string) => Promise<{ success: boolean; error?: string; user?: User }>;
      microsoftLogin: () => Promise<{ success: boolean; error?: string; user?: User; account?: MinecraftAccount }>;
      getCurrentUser: () => Promise<{ success: boolean; error?: string; user?: User }>;
      logout: () => Promise<{ success: boolean }>;
      getMinecraftAccounts: () => Promise<MinecraftAccount[]>;
      setActiveMinecraftAccount: (accountId: string) => Promise<{ success: boolean; error?: string; user?: User }>;
      removeMinecraftAccount: (accountId: string) => Promise<{ success: boolean; error?: string; accounts?: MinecraftAccount[] }>;

      listServers: () => Promise<SavedServer[]>;
      addServer: (payload: { address: string; manifestPort?: number; manifestKey?: string | null }) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      previewInvitation: (raw: string) => Promise<{ success: boolean; error?: string; invitation?: ImpulseInvitation; server?: SavedServer }>;
      consumeDeepLinks: () => Promise<ImpulseInvitation[]>;
      refreshServer: (serverId: string) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[]; details?: OfflineDetails }>;
      updateOptionalMods: (serverId: string, selections: Record<string, boolean>, markPrompted?: boolean) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      dismissOutdatedVersionWarning: (serverId: string) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      acceptUnverifiedMods: (serverId: string, signature: string) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      respondCrashSharing: (reportId: string, share: boolean, remember?: boolean) => Promise<{ success: boolean; error?: string; shared?: boolean; servers?: SavedServer[] }>;
      updateCrashSharing: (serverId: string, preference: 'ask' | 'always' | 'never') => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      retryCrashReports: (serverId?: string | null) => Promise<{ success: boolean; error?: string }>;
      markAnnouncementsRead: (serverId: string, ids: string[]) => Promise<{ success: boolean; error?: string; server?: SavedServer; servers?: SavedServer[] }>;
      removeServer: (serverId: string) => Promise<{ success: boolean; servers?: SavedServer[] }>;
      launchServer: (serverId: string) => Promise<{ success: boolean; error?: string; details?: OfflineDetails; verificationRequired?: boolean; server?: SavedServer }>;
      cancelLaunch: (serverId: string) => Promise<{ success: boolean; error?: string }>;
      verifyServerFiles: (serverId: string) => Promise<{ success: boolean; error?: string; details?: OfflineDetails; report?: RepairReport | null; server?: SavedServer }>;

      getLauncherSettings: () => Promise<{
        minecraftPath: string;
        updateChannel: 'stable' | 'beta';
        javaRuntime: 'auto' | 'custom';
        javaPath: string | null;
        minMemory: number;
        maxMemory: number;
        downloadSettings: {
          concurrentDownloads: number;
          connectionsPerHost: number;
          timeout: number;
        };
        discordRpc: DiscordRpcSettings;
      }>;
      getMicrophonePermission: () => Promise<{ supported: boolean; status: string; granted: boolean; error?: string }>;
      requestMicrophonePermission: () => Promise<{ supported: boolean; status: string; granted: boolean; error?: string }>;
      updateLauncherSettings: (settings: Record<string, unknown>) => Promise<{ success: boolean; error?: string; updateChannel?: 'stable' | 'beta' }>;
      clearGameFiles: () => Promise<{ success: boolean; error?: string; cleared?: string[] }>;
      getGameStorage: () => Promise<{ success: boolean; error?: string; storage?: GameStorage }>;
      verifyGameCache: () => Promise<{ success: boolean; error?: string; result?: { checked: number; valid: number; corruptRemoved: number } }>;
      cleanGameCache: () => Promise<{ success: boolean; error?: string; removed?: number; bytesFreed?: number }>;

      onLaunchProgress: (callback: (data: LaunchProgress) => void) => () => void;
      onLaunched: (callback: (data: RunningGame & { message: string }) => void) => () => void;
      onLaunchError: (callback: (data: { serverId?: string; error: string; logPath?: string; diagnosticsDir?: string; details?: OfflineDetails }) => void) => () => void;
      onGameClosed: (callback: (data: CrashReport & { crashed?: boolean }) => void) => () => void;
      onCrashShareStatus: (callback: (data: { reportId: string; serverId: string; status: CrashShareStatus; message?: string }) => void) => () => void;
      onDeepLink: (callback: (data: ImpulseInvitation) => void) => () => void;

      checkForUpdates: () => Promise<void>;
      downloadUpdate: () => Promise<void>;
      installUpdate: () => Promise<void>;
      getAppVersion: () => Promise<string>;
      onUpdateStatus: (callback: (data: {
        status: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'error';
        channel?: 'stable' | 'beta';
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
