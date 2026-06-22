/**
 * Persistent key-value storage for the Lynx client.
 *
 * Lynx runs JS in a background thread with no `window`/`localStorage`. The host
 * platform exposes persistent storage through a native module (NSUserDefaults
 * on iOS, SharedPreferences on Android) reachable via the global
 * `NativeModules`. We wrap its callback-based surface in a small Promise API,
 * and fall back to an in-memory map when the module is unavailable (e.g. tests
 * under jsdom, or a host that hasn't registered it) so the app never crashes
 * for the want of a native backend.
 */

/** A small async key-value store, the surface the rest of the app depends on. */
export interface PersistentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The Lynx native storage module, as registered by the host platform. */
export interface NativeLocalStorageModule {
  setStorageItem(key: string, value: string): void;
  getStorageItem(
    key: string,
    callback: (value: string | null | undefined) => void,
  ): void;
  clearStorage(): void;
}

/**
 * Resolve the host's native storage module, or `null` when it isn't present.
 * The module has no per-key delete (only `clearStorage`), so `removeItem` is
 * modelled by writing an empty string, which `getItem` reads back as `null`.
 */
export function createNativeStorage(
  mod: NativeLocalStorageModule,
): PersistentStorage {
  return {
    getItem(key) {
      return new Promise((resolve) => {
        mod.getStorageItem(key, (value) => resolve(value ? value : null));
      });
    },
    setItem(key, value) {
      mod.setStorageItem(key, value);
      return Promise.resolve();
    },
    removeItem(key) {
      mod.setStorageItem(key, '');
      return Promise.resolve();
    },
  };
}

/** An in-memory store used when no native backend is available. */
export function createMemoryStorage(): PersistentStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(map.get(key) ?? null),
    setItem: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

function findNativeModule(): NativeLocalStorageModule | null {
  const modules = (globalThis as { NativeModules?: Record<string, unknown> })
    .NativeModules;
  const mod = modules?.NativeLocalStorageModule as
    | NativeLocalStorageModule
    | undefined;
  if (
    mod &&
    typeof mod.setStorageItem === 'function' &&
    typeof mod.getStorageItem === 'function'
  ) {
    return mod;
  }
  return null;
}

function resolveStorage(): PersistentStorage {
  const native = findNativeModule();
  return native ? createNativeStorage(native) : createMemoryStorage();
}

/** The app-wide persistent store: native when present, in-memory otherwise. */
export const storage: PersistentStorage = resolveStorage();
