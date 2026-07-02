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

import api from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfigEntry {
  key: string;
  value: string;
}

export interface ApiConfigEntry extends ConfigEntry {
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

/** GET /appconfig — Returns all stored configs from the database */
export async function getAllConfigs(): Promise<ApiConfigEntry[]> {
  const res = await api.get<{ configs: ApiConfigEntry[]; total: number }>('/appconfig');
  return res.data.configs;
}

/** GET /appconfig/{key} — Fetch a specific config entry by key */
export async function getConfigByKey(key: string): Promise<ConfigEntry> {
  const res = await api.get<ConfigEntry>(`/appconfig/${encodeURIComponent(key)}`);
  return res.data;
}

export type PendingChanges = Record<string, { from: string | null; to: string | null }>;

export interface ReloadConfigResponse {
  message: string;
  added: Record<string, unknown>;
  removed: string[];
  updated: PendingChanges;
}

/** GET /appconfig/effective — Returns the pending changes (keys that differ from current runtime config) */
export async function fetchEffectiveConfig(): Promise<PendingChanges> {
  const res = await api.get<unknown>('/appconfig/effective');
  const data = res.data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (obj['pending'] && typeof obj['pending'] === 'object') {
      return obj['pending'] as PendingChanges;
    }
  }
  return {};
}

/** POST /appconfig — Creates a single config entry */
export async function createConfigEntry(entry: ConfigEntry): Promise<void> {
  await api.post('/appconfig', entry);
}

/** POST /appconfig for every entry in the array (sequentially) */
export async function createAllConfigEntries(entries: ConfigEntry[]): Promise<void> {
  for (const entry of entries) {
    await createConfigEntry(entry);
  }
}

/** PUT /appconfig/{key} — Updates value for a given key */
export async function updateConfigEntry(key: string, value: string): Promise<void> {
  await api.put(`/appconfig/${encodeURIComponent(key)}`, { key, value });
}

/** PUT /appconfig/{key} for all entries sequentially */
export async function updateAllConfigEntries(entries: ConfigEntry[]): Promise<void> {
  for (const entry of entries) {
    await updateConfigEntry(entry.key, entry.value);
  }
}

/** DELETE /appconfig/{key} — Deletes a config entry */
export async function deleteConfigEntry(key: string): Promise<void> {
  await api.delete(`/appconfig/${encodeURIComponent(key)}`);
}

/** POST /appconfig/reload — Triggers a runtime config reload, returns server response */
export async function reloadAppConfig(): Promise<ReloadConfigResponse> {
  const res = await api.post<ReloadConfigResponse>('/appconfig/reload');
  return res.data;
}
