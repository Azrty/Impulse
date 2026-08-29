export type BridgeResponse<T = unknown> = { ok: boolean; data?: T; error?: string };

declare global {
  interface Window {
    impulseBridge?: (request: string) => Promise<string>;
  }
}

export async function invoke<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!window.impulseBridge) throw new Error('The Impulse native bridge is unavailable.');
  const raw = await window.impulseBridge(JSON.stringify({ action, ...payload }));
  const response = JSON.parse(raw) as BridgeResponse<T>;
  if (!response.ok) throw new Error(response.error || 'The operation failed.');
  return response.data as T;
}

export function heartbeat(): void {
  void invoke('heartbeat').catch(() => undefined);
}
