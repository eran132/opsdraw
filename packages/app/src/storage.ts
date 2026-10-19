/** localStorage for small per-user preferences; silently does nothing where storage is blocked. */
export const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`opsdraw:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`opsdraw:${key}`, value);
    } catch {
      // Private mode or blocked storage: preferences just won't persist.
    }
  },
};
