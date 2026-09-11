// One request at a time; late replies from a previous operation cannot change the UI.
export function pollOperation<T>(request: () => Promise<T>, receive: (value: T) => Promise<boolean>,
  failed: (error: unknown) => void, interval = 300, timeout = 0): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const value = timeout > 0 ? await Promise.race([
          request(),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Unable to check launch progress.')), timeout);
          }),
        ]) : await request();
      clearTimeout(deadline);
      if (stopped) return;
      if (await receive(value)) stopped = true;
    } catch (error) {
      clearTimeout(deadline);
      if (!stopped) failed(error);
    }
    if (!stopped) timer = setTimeout(poll, interval);
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); };
}
