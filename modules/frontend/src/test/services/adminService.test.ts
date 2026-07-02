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
import { adminService, type UserApiResponse } from '../../services/adminService';
import api from '../../services/api';

// ── Mock the axios api instance ───────────────────────────────────────────────

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

const mockUser: UserApiResponse = {
  id: 'user-123',
  userName: 'fbaggins',
  firstName: 'Frodo',
  lastName: 'Baggins',
  email: 'fbaggins@hobbitmail.me',
  isSuper: false,
  isSupport: false,
  lockStatus: 'Unlocked',
  created: '2024-01-01T00:00:00Z',
};

// ── adminService ──────────────────────────────────────────────────────────────

describe('adminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── getUserByIdOrName ───────────────────────────────────────────────────────

  describe('getUserByIdOrName', () => {
    it('calls GET /users/lookupuser/{usernameOrId}', () => {
      mockApi.get.mockResolvedValueOnce({ data: mockUser });
      adminService.getUserByIdOrName('fbaggins');
      expect(mockApi.get).toHaveBeenCalledWith('/users/lookupuser/fbaggins');
    });

    it('URL-encodes usernames with special characters', () => {
      mockApi.get.mockResolvedValueOnce({ data: mockUser });
      adminService.getUserByIdOrName('user name');
      expect(mockApi.get).toHaveBeenCalledWith('/users/lookupuser/user%20name');
    });

    it('URL-encodes usernames with @ character', () => {
      mockApi.get.mockResolvedValueOnce({ data: mockUser });
      adminService.getUserByIdOrName('user@domain.com');
      expect(mockApi.get).toHaveBeenCalledWith('/users/lookupuser/user%40domain.com');
    });

    it('returns the axios response directly', async () => {
      const response = { data: mockUser };
      mockApi.get.mockResolvedValueOnce(response);
      const result = await adminService.getUserByIdOrName('fbaggins');
      expect(result).toEqual(response);
    });

    it('looks up a user by UUID id', () => {
      mockApi.get.mockResolvedValueOnce({ data: mockUser });
      adminService.getUserByIdOrName('user-123');
      expect(mockApi.get).toHaveBeenCalledWith('/users/lookupuser/user-123');
    });

    it('propagates API errors', async () => {
      mockApi.get.mockRejectedValueOnce(new Error('Not found'));
      await expect(adminService.getUserByIdOrName('nobody')).rejects.toThrow('Not found');
    });
  });

  // ── lockUser ────────────────────────────────────────────────────────────────

  describe('lockUser', () => {
    it('calls PUT /users/{userId}/lock with an empty body', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.lockUser('user-123');
      expect(mockApi.put).toHaveBeenCalledWith('/users/user-123/lock', {});
    });

    it('URL-encodes user IDs with special characters', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.lockUser('user/123');
      expect(mockApi.put).toHaveBeenCalledWith('/users/user%2F123/lock', {});
    });

    it('returns the axios response directly', async () => {
      const response = { data: { ...mockUser, lockStatus: 'Locked' } };
      mockApi.put.mockResolvedValueOnce(response);
      const result = await adminService.lockUser('user-123');
      expect(result).toEqual(response);
    });

    it('propagates API errors', async () => {
      mockApi.put.mockRejectedValueOnce(new Error('Forbidden'));
      await expect(adminService.lockUser('user-123')).rejects.toThrow('Forbidden');
    });
  });

  // ── unlockUser ──────────────────────────────────────────────────────────────

  describe('unlockUser', () => {
    it('calls PUT /users/{userId}/unlock with an empty body', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.unlockUser('user-123');
      expect(mockApi.put).toHaveBeenCalledWith('/users/user-123/unlock', {});
    });

    it('URL-encodes user IDs with special characters', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.unlockUser('user/abc');
      expect(mockApi.put).toHaveBeenCalledWith('/users/user%2Fabc/unlock', {});
    });

    it('returns the axios response directly', async () => {
      const response = { data: { ...mockUser, lockStatus: 'Unlocked' } };
      mockApi.put.mockResolvedValueOnce(response);
      const result = await adminService.unlockUser('user-123');
      expect(result).toEqual(response);
    });

    it('propagates API errors', async () => {
      mockApi.put.mockRejectedValueOnce(new Error('Forbidden'));
      await expect(adminService.unlockUser('user-123')).rejects.toThrow('Forbidden');
    });
  });

  // ── updatePermission ────────────────────────────────────────────────────────

  describe('updatePermission', () => {
    it('calls PUT /users/{userId}/update/makesuper for MakeSuper', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.updatePermission('user-123', 'MakeSuper');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/users/user-123/update/makesuper',
        {}
      );
    });

    it('calls PUT /users/{userId}/update/removesuper for RemoveSuper', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.updatePermission('user-123', 'RemoveSuper');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/users/user-123/update/removesuper',
        {}
      );
    });

    it('calls PUT /users/{userId}/update/makesupport for MakeSupport', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.updatePermission('user-123', 'MakeSupport');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/users/user-123/update/makesupport',
        {}
      );
    });

    it('calls PUT /users/{userId}/update/removesupport for RemoveSupport', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.updatePermission('user-123', 'RemoveSupport');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/users/user-123/update/removesupport',
        {}
      );
    });

    it('URL-encodes user IDs with special characters', () => {
      mockApi.put.mockResolvedValueOnce({ data: mockUser });
      adminService.updatePermission('user/456', 'MakeSuper');
      expect(mockApi.put).toHaveBeenCalledWith(
        '/users/user%2F456/update/makesuper',
        {}
      );
    });

    it('returns the axios response directly', async () => {
      const response = { data: { ...mockUser, isSuper: true } };
      mockApi.put.mockResolvedValueOnce(response);
      const result = await adminService.updatePermission('user-123', 'MakeSuper');
      expect(result).toEqual(response);
    });

    it('propagates API errors', async () => {
      mockApi.put.mockRejectedValueOnce(new Error('Not found'));
      await expect(
        adminService.updatePermission('user-123', 'MakeSuper')
      ).rejects.toThrow('Not found');
    });
  });
});
