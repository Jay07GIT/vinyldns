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

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from '../../pages/AdminPage';
import { frodoUser, superFrodoUser } from '../fixtures/testData';

// ── Alert context mock ────────────────────────────────────────────────────────

const mockAddAlert = vi.fn();

vi.mock('../../contexts/AlertContext', () => ({
  useAlerts: vi.fn(() => ({
    alerts: [],
    addAlert: mockAddAlert,
    removeAlert: vi.fn(),
    clearAlerts: vi.fn(),
  })),
}));

// ── Profile context mock ──────────────────────────────────────────────────────

vi.mock('../../contexts/ProfileContext', () => ({
  useProfile: vi.fn(),
}));

import { useProfile } from '../../contexts/ProfileContext';
const mockUseProfile = useProfile as unknown as ReturnType<typeof vi.fn>;

// ── Config service mock ───────────────────────────────────────────────────────

const mockGetAllConfigs = vi.fn();
const mockUpdateAllConfigEntries = vi.fn();
const mockCreateAllConfigEntries = vi.fn();
const mockDeleteConfigEntry = vi.fn();
const mockFetchEffectiveConfig = vi.fn();
const mockReloadAppConfig = vi.fn();

vi.mock('../../services/configService', () => ({
  getAllConfigs:            (...a: unknown[]) => mockGetAllConfigs(...a),
  updateAllConfigEntries:  (...a: unknown[]) => mockUpdateAllConfigEntries(...a),
  createAllConfigEntries:  (...a: unknown[]) => mockCreateAllConfigEntries(...a),
  deleteConfigEntry:       (...a: unknown[]) => mockDeleteConfigEntry(...a),
  fetchEffectiveConfig:    (...a: unknown[]) => mockFetchEffectiveConfig(...a),
  reloadAppConfig:         (...a: unknown[]) => mockReloadAppConfig(...a),
}));

// ── Admin service mock ────────────────────────────────────────────────────────

const mockGetUserByIdOrName = vi.fn();
const mockLockUser = vi.fn();
const mockUnlockUser = vi.fn();
const mockUpdatePermission = vi.fn();

vi.mock('../../services/adminService', () => ({
  adminService: {
    getUserByIdOrName: (...a: unknown[]) => mockGetUserByIdOrName(...a),
    lockUser:          (...a: unknown[]) => mockLockUser(...a),
    unlockUser:        (...a: unknown[]) => mockUnlockUser(...a),
    updatePermission:  (...a: unknown[]) => mockUpdatePermission(...a),
  },
}));

// ── Mock config data (covers boolean / numeric / string / array tabs) ─────────

const mockConfigEntries = [
  { key: 'feature-enabled',       value: 'false' },
  { key: 'max-connections',       value: '100' },
  { key: 'base-url',              value: 'http://example.com' },
  { key: 'approved-name-servers', value: '["ns1.example.com.","ns2.example.com."]' },
];

// ── Render helpers ────────────────────────────────────────────────────────────

function renderAsSuper() {
  mockUseProfile.mockReturnValue({ profile: superFrodoUser, loading: false, error: null, refresh: vi.fn() });
  return render(<AdminPage />);
}

function renderAsNormalUser() {
  mockUseProfile.mockReturnValue({ profile: frodoUser, loading: false, error: null, refresh: vi.fn() });
  return render(<AdminPage />);
}

async function switchToUsersTab() {
  await userEvent.click(screen.getByRole('button', { name: /user access/i }));
}

// ── Default mock behaviours ────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllConfigs.mockResolvedValue(mockConfigEntries);
  mockUpdateAllConfigEntries.mockResolvedValue(undefined);
  mockCreateAllConfigEntries.mockResolvedValue(undefined);
  mockDeleteConfigEntry.mockResolvedValue(undefined);
  mockFetchEffectiveConfig.mockResolvedValue({});
  mockReloadAppConfig.mockResolvedValue({ message: 'Configuration reloaded successfully.' });
  // Default: user lookup fails (simulates "not found" scenario)
  mockGetUserByIdOrName.mockRejectedValue(new Error('Not found'));
  mockLockUser.mockResolvedValue({ data: {} });
  mockUnlockUser.mockResolvedValue({ data: {} });
  mockUpdatePermission.mockResolvedValue({ data: {} });
});

// ── AdminPage ─────────────────────────────────────────────────────────────────

describe('AdminPage', () => {

  // ── rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the Admin Control Panel heading', () => {
      renderAsSuper();
      expect(screen.getByText('Admin Control Panel')).toBeInTheDocument();
    });

    it('renders Configuration and User Access page-level tab buttons', () => {
      renderAsSuper();
      expect(screen.getByRole('button', { name: /configuration/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /user access/i })).toBeInTheDocument();
    });

    it('shows Configuration tab as active by default', () => {
      renderAsSuper();
      expect(screen.getByRole('button', { name: /configuration/i }))
        .toHaveClass('vds-pill-toggle__btn--active');
    });

    it('shows Create, Update, and Delete action buttons on Configuration tab', () => {
      renderAsSuper();
      expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /update/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });

    it('fetches config from the API on mount', async () => {
      renderAsSuper();
      await waitFor(() => expect(mockGetAllConfigs).toHaveBeenCalledTimes(1));
    });

    it('shows the page for any user role', async () => {
      renderAsNormalUser();
      expect(screen.getByText('Admin Control Panel')).toBeInTheDocument();
      await switchToUsersTab();
      expect(screen.getByText('User Access Management')).toBeInTheDocument();
    });
  });

  // ── page-level tabs ────────────────────────────────────────────────────────

  describe('page-level tabs', () => {
    it('shows Configuration Profile section by default', () => {
      renderAsSuper();
      expect(screen.getByText('Configuration Profile')).toBeInTheDocument();
    });

    it('shows User Access Management section when User Access tab is clicked', async () => {
      renderAsSuper();
      await switchToUsersTab();
      expect(screen.getByText('User Access Management')).toBeInTheDocument();
    });

    it('hides Configuration Profile section when User Access tab is active', async () => {
      renderAsSuper();
      await switchToUsersTab();
      expect(screen.queryByText('Configuration Profile')).toBeNull();
    });

    it('can switch back to Configuration tab after visiting User Access', async () => {
      renderAsSuper();
      await switchToUsersTab();
      await userEvent.click(screen.getByRole('button', { name: /configuration/i }));
      expect(screen.getByText('Configuration Profile')).toBeInTheDocument();
    });
  });

  // ── config tabs (dynamically derived from API) ─────────────────────────────

  describe('config tabs (dynamic from API)', () => {
    it('shows Boolean tab after config loads', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /boolean/i })).toBeInTheDocument()
      );
    });

    it('shows Numeric tab after config loads', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /numeric/i })).toBeInTheDocument()
      );
    });

    it('shows String tab after config loads', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /string/i })).toBeInTheDocument()
      );
    });

    it('shows Array tab after config loads', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /array/i })).toBeInTheDocument()
      );
    });

    it('renders the boolean key label on the Boolean tab (default active)', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByText('feature-enabled')).toBeInTheDocument()
      );
    });

    it('shows numeric input when Numeric tab is clicked', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /numeric/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /numeric/i }));
      expect(screen.getByDisplayValue('100')).toBeInTheDocument();
    });

    it('shows string textarea with current value when String tab is clicked', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /string/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /string/i }));
      expect(screen.getByDisplayValue('http://example.com')).toBeInTheDocument();
    });

    it('shows array tags when Array tab is clicked', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /array/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /array/i }));
      expect(screen.getByText('ns1.example.com.')).toBeInTheDocument();
      expect(screen.getByText('ns2.example.com.')).toBeInTheDocument();
    });

    it('shows an error message when config fails to load', async () => {
      mockGetAllConfigs.mockRejectedValue(new Error('Network error'));
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByText(/failed to load configuration/i)).toBeInTheDocument()
      );
    });
  });

  // ── BoolToggle ─────────────────────────────────────────────────────────────

  describe('BoolToggle', () => {
    it('shows the current value label (false) for feature-enabled', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByText('feature-enabled')).toBeInTheDocument()
      );
      expect(screen.getByText('false')).toBeInTheDocument();
    });

    it('toggles the boolean value when the toggle button is clicked', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByText('feature-enabled')).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { pressed: false }));
      expect(screen.getByText('true')).toBeInTheDocument();
    });
  });

  // ── Update Config button ────────────────────────────────────────────────────

  describe('Update Config button', () => {
    it('shows "No changes to save" when nothing has been modified', async () => {
      renderAsSuper();
      await waitFor(() => expect(mockGetAllConfigs).toHaveBeenCalled());
      await userEvent.click(screen.getByRole('button', { name: /update/i }));
      await waitFor(() =>
        expect(mockAddAlert).toHaveBeenCalledWith('info', 'No changes to save.')
      );
    });

    it('fires a success alert after modifying a numeric value and clicking Update', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /numeric/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /numeric/i }));
      const input = screen.getByDisplayValue('100');
      await userEvent.clear(input);
      await userEvent.type(input, '200');
      await userEvent.click(screen.getByRole('button', { name: /update/i }));
      await waitFor(() =>
        expect(mockAddAlert).toHaveBeenCalledWith('success', 'Configuration saved successfully.')
      );
    });
  });

  // ── Reload Config button ────────────────────────────────────────────────────

  describe('Reload Config button', () => {
    it('shows info alert when config is already up to date', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /reload config/i }));
      await waitFor(() =>
        expect(mockAddAlert).toHaveBeenCalledWith(
          'info',
          'Config is up to date. No pending changes to apply.'
        )
      );
    });

    it('opens an Effective Config Preview modal when there are pending changes', async () => {
      mockFetchEffectiveConfig.mockResolvedValue({
        'feature-enabled': { from: 'false', to: 'true' },
      });
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /reload config/i }));
      await waitFor(() =>
        expect(screen.getByText('Effective Config Preview')).toBeInTheDocument()
      );
    });

    it('shows the pending key in the preview modal', async () => {
      mockFetchEffectiveConfig.mockResolvedValue({
        'feature-enabled': { from: 'false', to: 'true' },
      });
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /reload config/i }));
      await waitFor(() => screen.getByText('Effective Config Preview'));
      // The modal shows how many pending changes will be applied
      expect(screen.getByText(/pending change/i)).toBeInTheDocument();
    });

    it('reloads config and shows toast when Reload Config is confirmed in the modal', async () => {
      mockFetchEffectiveConfig.mockResolvedValue({
        'feature-enabled': { from: 'false', to: 'true' },
      });
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /reload config/i }));
      await waitFor(() => screen.getByText('Effective Config Preview'));
      const reloadBtns = screen.getAllByRole('button', { name: /reload config/i });
      await userEvent.click(reloadBtns[reloadBtns.length - 1]);
      await waitFor(() =>
        expect(screen.getByText(/configuration reloaded successfully/i)).toBeInTheDocument()
      );
    });

    it('closes the preview modal when Cancel is clicked', async () => {
      mockFetchEffectiveConfig.mockResolvedValue({
        'feature-enabled': { from: 'false', to: 'true' },
      });
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /reload config/i }));
      await waitFor(() => screen.getByText('Effective Config Preview'));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByText('Effective Config Preview')).toBeNull();
    });
  });

  // ── Create Config modal ────────────────────────────────────────────────────

  describe('Create Config modal', () => {
    it('opens when the Create button is clicked', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /create/i }));
      expect(screen.getByText('Create Config Entries')).toBeInTheDocument();
    });

    it('closes when Cancel is clicked', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /create/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByText('Create Config Entries')).toBeNull();
    });

    it('shows key validation error when submitted with an empty key', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /create/i }));
      const createBtns = screen.getAllByRole('button', { name: /^create$/i });
      await userEvent.click(createBtns[createBtns.length - 1]);
      expect(screen.getByText(/key is required/i)).toBeInTheDocument();
    });

    it('creates a boolean config entry successfully', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /create/i }));
      await userEvent.type(screen.getByPlaceholderText(/enter key name/i), 'my-new-feature');
      const createBtns = screen.getAllByRole('button', { name: /^create$/i });
      await userEvent.click(createBtns[createBtns.length - 1]);
      await waitFor(() =>
        expect(mockAddAlert).toHaveBeenCalledWith('success', expect.stringContaining('Created'))
      );
    });

    it('adds a new row when Add Row button is clicked', async () => {
      renderAsSuper();
      await userEvent.click(screen.getByRole('button', { name: /create/i }));
      const before = screen.getAllByPlaceholderText(/enter key name/i).length;
      await userEvent.click(screen.getByRole('button', { name: /add row/i }));
      expect(screen.getAllByPlaceholderText(/enter key name/i)).toHaveLength(before + 1);
    });
  });

  // ── Delete mode ────────────────────────────────────────────────────────────

  describe('Delete mode', () => {
    it('enters delete selection mode and shows the key selector', async () => {
      renderAsSuper();
      // Wait for config to finish loading before clicking Delete
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /boolean/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
      expect(screen.getByText(/select keys to delete/i)).toBeInTheDocument();
    });

    it('exits delete mode when Cancel is clicked', async () => {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /boolean/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByText(/select keys to delete/i)).toBeNull();
    });
  });

  // ── TagInput — Array tab ───────────────────────────────────────────────────

  describe('TagInput — Array tab', () => {
    async function openArrayTab() {
      renderAsSuper();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /array/i })).toBeInTheDocument()
      );
      await userEvent.click(screen.getByRole('button', { name: /array/i }));
    }

    it('renders existing name server tags', async () => {
      await openArrayTab();
      expect(screen.getByText('ns1.example.com.')).toBeInTheDocument();
      expect(screen.getByText('ns2.example.com.')).toBeInTheDocument();
    });

    it('adds a new tag when a value is typed and Enter is pressed', async () => {
      await openArrayTab();
      const input = document.querySelector('.adm-tag-input__field') as HTMLInputElement;
      await userEvent.type(input, 'ns3.new.com.');
      await userEvent.keyboard('{Enter}');
      expect(screen.getByText('ns3.new.com.')).toBeInTheDocument();
    });

    it('removes a tag when its × button is clicked', async () => {
      await openArrayTab();
      await userEvent.click(screen.getByLabelText('Remove ns1.example.com.'));
      expect(screen.queryByText('ns1.example.com.')).toBeNull();
    });

    it('does not add duplicate tags', async () => {
      await openArrayTab();
      const input = document.querySelector('.adm-tag-input__field') as HTMLInputElement;
      await userEvent.type(input, 'ns1.example.com.');
      await userEvent.keyboard('{Enter}');
      expect(screen.getAllByText('ns1.example.com.')).toHaveLength(1);
    });

    it('adds a tag on blur', async () => {
      await openArrayTab();
      const input = document.querySelector('.adm-tag-input__field') as HTMLInputElement;
      await userEvent.type(input, 'blur-test.com.');
      input.blur();
      await waitFor(() =>
        expect(screen.getByText('blur-test.com.')).toBeInTheDocument()
      );
    });

    it('removes the last tag on Backspace when the input is empty', async () => {
      await openArrayTab();
      const input = document.querySelector('.adm-tag-input__field') as HTMLInputElement;
      await userEvent.click(input);
      await userEvent.keyboard('{Backspace}');
      expect(screen.queryByText('ns2.example.com.')).not.toBeInTheDocument();
    });
  });

  // ── User management panels ─────────────────────────────────────────────────

  describe('User management panels', () => {

    // ── Lock / Unlock ──────────────────────────────────────────────────────

    describe('Lock / Unlock panel', () => {
      it('shows an error when looking up a non-existent user', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const [lockInput] = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(lockInput, 'unknown-user');
        await userEvent.click(screen.getAllByRole('button', { name: /submit/i })[0]);
        await waitFor(() =>
          expect(screen.getByText(/failed to look up user/i)).toBeInTheDocument()
        );
      });

      it('shows a mandatory error when username is empty', async () => {
        renderAsSuper();
        await switchToUsersTab();
        await userEvent.click(screen.getAllByRole('button', { name: /submit/i })[0]);
        expect(screen.getByText(/username is mandatory/i)).toBeInTheDocument();
      });

      it('defaults the action radio to Lock', async () => {
        renderAsSuper();
        await switchToUsersTab();
        expect(screen.getByRole('radio', { name: /^lock$/i })).toBeChecked();
      });

      it('submits the lock form using the Enter key', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const [lockInput] = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(lockInput, 'unknown-user{Enter}');
        await waitFor(() =>
          expect(screen.getByText(/failed to look up user/i)).toBeInTheDocument()
        );
      });

      it('clears lock panel input when Clear is clicked', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[0], 'test-user');
        const clearBtns = screen.getAllByRole('button', { name: /clear/i });
        await userEvent.click(clearBtns[0]);
        expect(inputs[0]).toHaveValue('');
      });
    });

    // ── Check Status ────────────────────────────────────────────────────────

    describe('Check Status panel', () => {
      it('shows "not found" message when the user does not exist', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[1], 'ghost-user');
        await userEvent.click(screen.getByRole('button', { name: /check status/i }));
        await waitFor(() =>
          expect(screen.getByText(/ghost-user/i)).toBeInTheDocument()
        );
        expect(screen.getByText(/not found/i)).toBeInTheDocument();
      });

      it('shows a mandatory error when username is empty', async () => {
        renderAsSuper();
        await switchToUsersTab();
        await userEvent.click(screen.getByRole('button', { name: /check status/i }));
        expect(screen.getByText(/username is mandatory/i)).toBeInTheDocument();
      });

      it('submits the status form using the Enter key', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[1], 'ghost-user{Enter}');
        await waitFor(() =>
          expect(screen.getByText(/ghost-user/i)).toBeInTheDocument()
        );
      });

      it('clears status panel input when Clear is clicked', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[1], 'test-user');
        const clearBtns = screen.getAllByRole('button', { name: /clear/i });
        await userEvent.click(clearBtns[1]);
        expect(inputs[1]).toHaveValue('');
      });
    });

    // ── Update Permission ────────────────────────────────────────────────────

    describe('Update Permission panel', () => {
      it('shows an error when the user does not exist', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[2], 'nobody');
        await userEvent.click(screen.getAllByRole('button', { name: /submit/i })[1]);
        await waitFor(() =>
          expect(screen.getByText(/failed to look up user/i)).toBeInTheDocument()
        );
      });

      it('defaults the permission radio to Make Super User', async () => {
        renderAsSuper();
        await switchToUsersTab();
        expect(screen.getByRole('radio', { name: /make super user/i })).toBeChecked();
      });

      it('submits the permission form using the Enter key', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[2], 'nobody{Enter}');
        await waitFor(() =>
          expect(screen.getByText(/failed to look up user/i)).toBeInTheDocument()
        );
      });

      it('clears permission panel input when Clear is clicked', async () => {
        renderAsSuper();
        await switchToUsersTab();
        const inputs = screen.getAllByPlaceholderText(/enter the username/i);
        await userEvent.type(inputs[2], 'test-user');
        const clearBtns = screen.getAllByRole('button', { name: /clear/i });
        await userEvent.click(clearBtns[2]);
        expect(inputs[2]).toHaveValue('');
      });
    });
  });
});

