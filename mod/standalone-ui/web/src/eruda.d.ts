declare module 'eruda' {
  type ErudaOptions = {
    defaults?: {
      displaySize?: number;
      transparency?: number;
    };
  };

  const eruda: {
    init(options?: ErudaOptions): void;
    show(): void;
    hide(): void;
    destroy(): void;
  };

  export default eruda;
}
