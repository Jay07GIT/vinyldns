/*
 * Copyright 2018 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getAllConfigs,
  getConfigByKey,
  fetchEffectiveConfig,
  createConfigEntry,
  createAllConfigEntries,
  updateConfigEntry,
  updateAllConfigEntries,
  deleteConfigEntry,
  reloadAppConfig,
  type ApiConfigEntry,
  type ConfigEntry,
} from '../../services/configService';
import api from '../../services/api';

// Mock the axios api instance

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

// ── Test data ─────────────────────────────────────────────────────────────────

const mockEntry: ApiConfigEntry = {
  key: 'feature-enabled',
  value: 'true',
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'admin',
  updatedAt: '2026-01-02T00:00:00Z',
  updatedBy: 'admin',
};

const mockEntries: ApiConfigEntry[] = [
  mockEntry,
  { key: 'max-connections', value: '100' },
  { key: 'base-url', value: 'http://example.com' },
];

// ── configService ─────────────────────────────────────────────────────────────

describe('configService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getAllConfigs ───────────────────────────────────────────────────────────

  describe('getAllConfigs', () => {
    it('calls GET /appconfig', async () => {
      mockApi.get.mockResolvedValueOnce({ data: { configs: mockEntries, total: 3 } });
      await getAllConfigs();
      expect(mockApi.get).toHaveBeenCalledWith('/appconfig');
    });

    it('returns the configs array from the response', async () => {
      mockApi.get.mockResolvedValueOnce({ data: { configs: mockEntries, total: 3 } });
      const result = await getAllConfigs();
      expect(result).toEqual(mockEntries);
    });

    it('returns an empty array when configs is empty', async () => {
      mockApi.get.mockResolvedValueOnce({ data: { configs: [], total: 0 } });
      const result = await getAllConfigs();
      expect(result).toEqual([]);
    });

    it('propagates API errors', async () => {
      mockApi.get.mockRejectedValueOnce(new Error('Network error'));
      await expect(getAllConfigs()).rejects.toThrow('Network error');
    });
  });

  // ── getConfigByKey ──────────────────────────────────────────────────────────

  describe('getConfigByKey', () => {
    it('calls GET /appconfig/{key} with URL-encoded key', async () => {
      mockApi.get.mockResolvedValueOnce({ data: mockEntry });
      await getConfigByKey('feature-enabled');
      expect(mockApi.get).toHaveBeenCalledWith('/appconfig/feature-enabled');
    });

    it('URL-encodes keys with special characters', async () => {
      mockApi.get.mockResolvedValueOnce({ data: { key: 'my key', value: 'v' } });
      await getConfigByKey('my key');
      expect(mockApi.get).toHaveBeenCalledWith('/appconfig/my%20key');
    });

    it('returns the config entry', async () => {
      mockApi.get.mockResolvedValueOnce({ data: mockEntry });
      const result = await getConfigByKey('feature-enabled');
      expect(result).toEqual(mockEntry);
    });

    it('propagates API errors', async () => {
      mockApi.get.mockRejectedValueOnce(new Error('Not found'));
      await expect(getConfigByKey('missing-key')).rejects.toThrow('Not found');
    });
  });

  // ── fetchEffectiveConfig ────────────────────────────────────────────────────

  describe('fetchEffectiveConfig', () => {
    it('calls GET /appconfig/effective', async () => {
      mockApi.get.mockResolvedValueOnce({ data: {} });
      await fetchEffectiveConfig();
      expect(mockApi.get).toHaveBeenCalledWith('/appconfig/effective');
    });

    it('returns pending changes when present in response', async () => {
      const pending = { 'feature-enabled': { from: 'false', to: 'true' } };
      mockApi.get.mockResolvedValueOnce({ data: { pending } });
      const result = await fetchEffectiveConfig();
      expect(result).toEqual(pending);
    });

    it('returns an empty object when no pending key exists', async () => {
      mockApi.get.mockResolvedValueOnce({ data: {} });
      const result = await fetchEffectiveConfig();
      expect(result).toEqual({});
    });

    it('returns an empty object when response data is not an object', async () => {
      mockApi.get.mockResolvedValueOnce({ data: null });
      const result = await fetchEffectiveConfig();
      expect(result).toEqual({});
    });

    it('returns an empty object when pending value is not an object', async () => {
      mockApi.get.mockResolvedValueOnce({ data: { pending: 'nope' } });
      const result = await fetchEffectiveConfig();
      expect(result).toEqual({});
    });

    it('propagates API errors', async () => {
      mockApi.get.mockRejectedValueOnce(new Error('Server error'));
      await expect(fetchEffectiveConfig()).rejects.toThrow('Server error');
    });
  });

  // ── createConfigEntry ───────────────────────────────────────────────────────

  describe('createConfigEntry', () => {
    it('calls POST /appconfig with the entry', async () => {
      mockApi.post.mockResolvedValueOnce({});
      await createConfigEntry({ key: 'new-key', value: 'new-value' });
      expect(mockApi.post).toHaveBeenCalledWith('/appconfig', { key: 'new-key', value: 'new-value' });
    });

    it('propagates API errors', async () => {
      mockApi.post.mockRejectedValueOnce(new Error('Conflict'));
      await expect(createConfigEntry({ key: 'dup', value: 'v' })).rejects.toThrow('Conflict');
    });
  });

  // ── createAllConfigEntries ──────────────────────────────────────────────────

  describe('createAllConfigEntries', () => {
    it('calls createConfigEntry for each entry sequentially', async () => {
      mockApi.post.mockResolvedValue({});
      const entries: ConfigEntry[] = [
        { key: 'key-a', value: 'val-a' },
        { key: 'key-b', value: 'val-b' },
        { key: 'key-c', value: 'val-c' },
      ];
      await createAllConfigEntries(entries);
      expect(mockApi.post).toHaveBeenCalledTimes(3);
      expect(mockApi.post).toHaveBeenNthCalledWith(1, '/appconfig', entries[0]);
      expect(mockApi.post).toHaveBeenNthCalledWith(2, '/appconfig', entries[1]);
      expect(mockApi.post).toHaveBeenNthCalledWith(3, '/appconfig', entries[2]);
    });

    it('does nothing when the entries array is empty', async () => {
      await createAllConfigEntries([]);
      expect(mockApi.post).not.toHaveBeenCalled();
    });

    it('propagates an error if any single entry fails', async () => {
      mockApi.post.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Fail'));
      await expect(
        createAllConfigEntries([
          { key: 'ok', value: 'v' },
          { key: 'bad', value: 'v' },
        ])
      ).rejects.toThrow('Fail');
    });
  });

  // ── updateConfigEntry ───────────────────────────────────────────────────────

  describe('updateConfigEntry', () => {
    it('calls PUT /appconfig/{key} with the key and value', async () => {
      mockApi.put.mockResolvedValueOnce({});
      await updateConfigEntry('feature-enabled', 'false');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/appconfig/feature-enabled',
        { key: 'feature-enabled', value: 'false' }
      );
    });

    it('URL-encodes keys with special characters', async () => {
      mockApi.put.mockResolvedValueOnce({});
      await updateConfigEntry('my key', 'v');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/appconfig/my%20key',
        { key: 'my key', value: 'v' }
      );
    });

    it('propagates API errors', async () => {
      mockApi.put.mockRejectedValueOnce(new Error('Not found'));
      await expect(updateConfigEntry('missing', 'v')).rejects.toThrow('Not found');
    });
  });

  // ── updateAllConfigEntries ──────────────────────────────────────────────────

  describe('updateAllConfigEntries', () => {
    it('calls updateConfigEntry for each entry sequentially', async () => {
      mockApi.put.mockResolvedValue({});
      const entries: ConfigEntry[] = [
        { key: 'key-a', value: 'v1' },
        { key: 'key-b', value: 'v2' },
      ];
      await updateAllConfigEntries(entries);
      expect(mockApi.put).toHaveBeenCalledTimes(2);
      expect(mockApi.put).toHaveBeenNthCalledWith(1, '/appconfig/key-a', entries[0]);
      expect(mockApi.put).toHaveBeenNthCalledWith(2, '/appconfig/key-b', entries[1]);
    });

    it('does nothing when the entries array is empty', async () => {
      await updateAllConfigEntries([]);
      expect(mockApi.put).not.toHaveBeenCalled();
    });

    it('propagates an error if any single entry fails', async () => {
      mockApi.put.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Server error'));
      await expect(
        updateAllConfigEntries([
          { key: 'ok', value: 'v' },
          { key: 'bad', value: 'v' },
        ])
      ).rejects.toThrow('Server error');
    });
  });

  // ── deleteConfigEntry ───────────────────────────────────────────────────────

  describe('deleteConfigEntry', () => {
    it('calls DELETE /appconfig/{key}', async () => {
      mockApi.delete.mockResolvedValueOnce({});
      await deleteConfigEntry('feature-enabled');
      expect(mockApi.delete).toHaveBeenCalledWith('/appconfig/feature-enabled');
    });

    it('URL-encodes keys with special characters', async () => {
      mockApi.delete.mockResolvedValueOnce({});
      await deleteConfigEntry('my key');
      expect(mockApi.delete).toHaveBeenCalledWith('/appconfig/my%20key');
    });

    it('propagates API errors', async () => {
      mockApi.delete.mockRejectedValueOnce(new Error('Not found'));
      await expect(deleteConfigEntry('missing')).rejects.toThrow('Not found');
    });
  });

  // ── reloadAppConfig ─────────────────────────────────────────────────────────

  describe('reloadAppConfig', () => {
    it('calls POST /appconfig/reload', async () => {
      mockApi.post.mockResolvedValueOnce({
        data: { message: 'Config reloaded.', added: {}, removed: [], updated: {} },
      });
      await reloadAppConfig();
      expect(mockApi.post).toHaveBeenCalledWith('/appconfig/reload');
    });

    it('returns the reload response', async () => {
      const response = { message: 'Config reloaded.', added: {}, removed: [], updated: {} };
      mockApi.post.mockResolvedValueOnce({ data: response });
      const result = await reloadAppConfig();
      expect(result).toEqual(response);
    });

    it('propagates API errors', async () => {
      mockApi.post.mockRejectedValueOnce(new Error('Service unavailable'));
      await expect(reloadAppConfig()).rejects.toThrow('Service unavailable');
    });
  });
});
