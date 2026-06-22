import { describe, expect, test, vi } from 'vitest';

import {
  createMemoryStorage,
  createNativeStorage,
  type NativeLocalStorageModule,
} from './storage.js';

describe('createMemoryStorage', () => {
  test('round-trips and removes values', async () => {
    const store = createMemoryStorage();

    expect(await store.getItem('k')).toBeNull();
    await store.setItem('k', 'v');
    expect(await store.getItem('k')).toBe('v');
    await store.removeItem('k');
    expect(await store.getItem('k')).toBeNull();
  });
});

describe('createNativeStorage', () => {
  function fakeModule(): NativeLocalStorageModule {
    const values = new Map<string, string>();
    return {
      setStorageItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      getStorageItem: vi.fn(
        (key: string, cb: (value: string | null | undefined) => void) => {
          cb(values.get(key));
        },
      ),
      clearStorage: vi.fn(() => values.clear()),
    };
  }

  test('writes through to the module and reads back via the callback', async () => {
    const mod = fakeModule();
    const store = createNativeStorage(mod);

    await store.setItem('token', 'abc');
    expect(mod.setStorageItem).toHaveBeenCalledWith('token', 'abc');
    expect(await store.getItem('token')).toBe('abc');
  });

  test('missing keys resolve to null', async () => {
    const store = createNativeStorage(fakeModule());
    expect(await store.getItem('absent')).toBeNull();
  });

  test('removeItem clears the value (read back as null)', async () => {
    const store = createNativeStorage(fakeModule());
    await store.setItem('token', 'abc');
    await store.removeItem('token');
    expect(await store.getItem('token')).toBeNull();
  });
});
