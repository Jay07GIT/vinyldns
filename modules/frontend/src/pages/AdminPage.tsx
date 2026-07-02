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

import React, { useState, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { useProfile } from '../contexts/ProfileContext';
import { useAlerts } from '../contexts/AlertContext';
import { adminService, type UserApiResponse } from '../services/adminService';
import '../styles/admin.css';
import {
  getAllConfigs,
  createAllConfigEntries,
  updateAllConfigEntries,
  deleteConfigEntry,
  fetchEffectiveConfig,
  reloadAppConfig,
  type ConfigEntry,
  type PendingChanges,
} from '../services/configService';
import {
  type ConfigTab,
  type ExpandedConfig,
  TAB_DISPLAY,
  deriveTabsFromFlat,
  flatKeyToApiKey,
  expandApiEntries,
  buildSavableEntries,
} from '../config/appConfigTabs';

// ─── Types ────────────────────────────────────────────────────────────────────

type Role = 'super' | 'support' | 'normal';

interface ManagedUser {
  id: string;
  userName: string;
  firstName: string;
  lastName: string;
  email: string;
  isSuper: boolean;
  isSupport: boolean;
  lockStatus: 'Unlocked' | 'Locked';
  created: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRoleFromUser(u: ManagedUser): Role {
  if (u.isSuper) return 'super';
  if (u.isSupport) return 'support';
  return 'normal';
}

function roleMeta(role: Role) {
  switch (role) {
    case 'super':   return { label: 'Super User',   cls: 'adm-badge adm-badge--super',   icon: 'bi-shield-fill-check' };
    case 'support': return { label: 'Support',       cls: 'adm-badge adm-badge--support', icon: 'bi-headset' };
    default:        return { label: 'Normal User',   cls: 'adm-badge adm-badge--normal',  icon: 'bi-person-fill' };
  }
}

function initials(u: ManagedUser) {
  return `${u.firstName[0] ?? ''}${u.lastName[0] ?? ''}`.toUpperCase();
}

function toManagedUser(u: UserApiResponse): ManagedUser {
  const dateStr = u.created
    ? new Date(u.created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '';
  return {
    id: u.id,
    userName: u.userName ?? u.id,
    firstName: u.firstName ?? '',
    lastName: u.lastName ?? '',
    email: u.email ?? '',
    isSuper: u.isSuper ?? false,
    isSupport: u.isSupport ?? false,
    lockStatus: (u.lockStatus ?? 'Unlocked') as 'Locked' | 'Unlocked',
    created: dateStr,
  };
}

type PermOp = 'MakeSuper' | 'RemoveSuper' | 'MakeSupport' | 'RemoveSupport';

const PERM_OP_LABELS: Record<PermOp, string> = {
  MakeSuper:     'Make Super User',
  RemoveSuper:   'Remove Super User',
  MakeSupport:   'Make Support User',
  RemoveSupport: 'Remove Support User',
};


// ─── Initial flat config — populated entirely from GET /appconfig ─────────────
const INITIAL_FLAT_CONFIG: Record<string, string> = {};

// ─── Tab override helpers (localStorage) ─────────────────────────────────────
const LS_TAB_OVERRIDES_KEY = 'vinyldns-ui-tab-overrides';

function loadTabOverrides(): Record<string, ConfigTab> {
  try { return JSON.parse(localStorage.getItem(LS_TAB_OVERRIDES_KEY) ?? '{}') as Record<string, ConfigTab>; } catch { return {}; }
}
function saveTabOverrides(overrides: Record<string, ConfigTab>): void {
  localStorage.setItem(LS_TAB_OVERRIDES_KEY, JSON.stringify(overrides));
}

// ─── TagInput ─────────────────────────────────────────────────────────────────

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

function TagInput({ tags, onChange, placeholder = 'Type and press Enter…' }: TagInputProps) {
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = () => {
    const trimmed = inputVal.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInputVal('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && inputVal === '' && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="adm-tag-input" onClick={() => inputRef.current?.focus()}>
      {tags.map((t) => (
        <span key={t} className="adm-tag">
          {t}
          <button
            type="button"
            className="adm-tag__remove"
            onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }}
            aria-label={`Remove ${t}`}
          >
            <i className="bi bi-x" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="adm-tag-input__field"
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={addTag}
        placeholder={tags.length === 0 ? placeholder : ''}
      />
    </div>
  );
}

// ─── BoolToggle ───────────────────────────────────────────────────────────────

function BoolToggle({ value, onChange, label, desc }: {
  value: boolean; onChange: () => void; label: string; desc?: string;
}) {
  return (
    <div className="adm-form-group">
      <div className="d-flex align-items-center justify-content-between gap-3">
        <div style={{ minWidth: 0 }}>
          <div className="adm-label" style={{ wordBreak: 'break-all' }}>{label}</div>
          {desc && <div style={{ fontSize: '0.7rem', color: 'var(--adm-text-muted)', marginTop: '0.1rem' }}>{desc}</div>}
        </div>
        <div className="d-flex align-items-center gap-2 flex-shrink-0">
          <span className={`adm-toggle-label${value ? ' adm-toggle-label--on' : ''}`}>{value ? 'true' : 'false'}</span>
          <button type="button" className={`adm-toggle-btn${value ? ' adm-toggle-btn--on' : ' adm-toggle-btn--off'}`} onClick={onChange} aria-pressed={value}>
            <span className="adm-toggle-btn__knob" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── AclRuleCard ──────────────────────────────────────────────────────────────

function AclRuleCard({ rule, index, label = 'Rule', open = false, onOpen, onChange, onRemove }: {
  rule: Record<string, unknown>;
  index: number;
  label?: string;
  open?: boolean;
  onOpen?: () => void;
  onChange: (r: Record<string, unknown>) => void;
  onRemove?: () => void;
}) {
  const setField = (k: string, v: unknown) => onChange({ ...rule, [k]: v });
  const arrayKeys = Object.keys(rule).filter(k => Array.isArray(rule[k]));
  const scalarKeys = Object.keys(rule).filter(k => !Array.isArray(rule[k]));
  return (
    <div className="adm-acl-card">
      <div className="adm-acl-card__header" onClick={() => onOpen?.()}>
        <div className="adm-acl-card__title">
          <i className="bi bi-shield-check adm-acl-card__icon" />
          <span>{label} {index + 1}</span>
        </div>
        <div className="adm-acl-card__actions">
          {onRemove && (
            <button type="button" className="adm-tag__remove" onClick={e => { e.stopPropagation(); onRemove(); }} aria-label="Remove rule" title="Remove this ACL rule">
              <i className="bi bi-trash3" />
            </button>
          )}
          <i className={`bi bi-chevron-${open ? 'up' : 'down'} adm-acl-card__chevron`} />
        </div>
      </div>
      {open && (
        <div className="adm-acl-card__body">
          <div className="row g-2">
            {scalarKeys.map(k => (
              <div key={k} className="col-md-4">
                <div className="adm-form-group" style={{ marginBottom: '0.4rem' }}>
                  <label className="adm-label" style={{ fontSize: '0.65rem' }}>{k}</label>
                  <input
                    className="adm-input"
                    value={String(rule[k] ?? '')}
                    onChange={e => setField(k, e.target.value)}
                  />
                </div>
              </div>
            ))}
            {arrayKeys.map(k => (
              <div key={k} className="col-md-6">
                <div className="adm-form-group" style={{ marginBottom: '0.4rem' }}>
                  <label className="adm-label" style={{ fontSize: '0.65rem' }}>{k}</label>
                  <TagInput
                    tags={rule[k] as string[]}
                    onChange={v => setField(k, v)}
                    placeholder={`Add ${k}…`}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BackendEditor ──────────────────────────────────────────────────────────

type BEConn = { name: string; 'key-name': string; key: string; 'primary-server': string };
type BEEntry = { id: string; 'zone-connection': BEConn; 'transfer-connection': BEConn; 'tsig-usage': string };
type BESettings = { legacy: boolean; backends: BEEntry[] };
type BEProvider = { 'class-name': string; settings: BESettings };
type BERoot = { 'default-backend-id': string; 'backend-providers': BEProvider[] };

const EMPTY_CONN: BEConn = { name: '', 'key-name': '', key: '', 'primary-server': '' };
const EMPTY_ENTRY: BEEntry = { id: '', 'zone-connection': { ...EMPTY_CONN }, 'transfer-connection': { ...EMPTY_CONN }, 'tsig-usage': 'always' };

function BackendItemCard({ entry, index, isDefault = false, open = false, onOpen, onChange, onRemove }: {
  entry: BEEntry; index: number; isDefault?: boolean; open?: boolean; onOpen?: () => void;
  onChange: (e: BEEntry) => void; onRemove?: () => void;
}) {
  const upd = (patch: Partial<BEEntry>) => onChange({ ...entry, ...patch });
  const updConn = (type: 'zone-connection' | 'transfer-connection', patch: Partial<BEConn>) =>
    upd({ [type]: { ...(entry[type] ?? EMPTY_CONN), ...patch } });
  const CONN_FIELDS = ['name', 'key-name', 'key', 'primary-server'] as const;
  return (
    <div className={`adm-acl-card${isDefault ? ' adm-acl-card--default' : ''}`}>
      <div className="adm-acl-card__header" onClick={() => onOpen?.()}>
        <div className="adm-acl-card__title">
          <i className="bi bi-hdd-network adm-acl-card__icon" />
          <span>Backend {index + 1}{entry.id ? ` — ${entry.id}` : ''}</span>
          {isDefault && <span className="adm-badge adm-badge--primary ms-2" style={{ fontSize: '0.62rem' }}>Default</span>}
        </div>
        <div className="adm-acl-card__actions">
          {onRemove && (
            <button type="button" className="adm-tag__remove" onClick={e => { e.stopPropagation(); onRemove(); }} aria-label="Remove backend">
              <i className="bi bi-trash3" />
            </button>
          )}
          <i className={`bi bi-chevron-${open ? 'up' : 'down'} adm-acl-card__chevron`} />
        </div>
      </div>
      {open && (
        <div className="adm-acl-card__body">
          <div className="row g-3 mb-2">
            <div className="col-md-6">
              <div className="adm-form-group">
                <label className="adm-label">id</label>
                <input className="adm-input" value={entry.id ?? ''} onChange={e => upd({ id: e.target.value })} />
              </div>
            </div>
            <div className="col-md-6">
              <div className="adm-form-group">
                <label className="adm-label">tsig-usage</label>
                <select className="adm-input adm-select" value={entry['tsig-usage'] ?? 'always'} onChange={e => upd({ 'tsig-usage': e.target.value })}>
                  <option value="always">always</option>
                  <option value="never">never</option>
                  <option value="auto">auto</option>
                </select>
              </div>
            </div>
          </div>
          <div className="row g-3">
            {(['zone-connection', 'transfer-connection'] as const).map(type => (
              <div key={type} className="col-md-6">
                <div className="adm-conn-block">
                  <div className="adm-conn-block__label">
                    <i className={`bi ${type === 'zone-connection' ? 'bi-arrow-left-right' : 'bi-arrow-repeat'}`} /> {type}
                  </div>
                  {CONN_FIELDS.map(f => (
                    <div key={f} className="adm-form-group">
                      <label className="adm-label" style={{ fontSize: '0.65rem' }}>{f}</label>
                      <input
                        className={`adm-input${f === 'key' ? ' adm-input--mono' : ''}`}
                        type={f === 'key' ? 'password' : 'text'}
                        value={entry[type]?.[f] ?? ''}
                        onChange={e => updConn(type, { [f]: e.target.value } as Partial<BEConn>)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BackendEditor({ value, onChange, openIdx, onToggle }: {
  value: string; onChange: (v: string) => void;
  openIdx: number | null; onToggle: (i: number) => void;
}) {
  let root: BERoot = { 'default-backend-id': '', 'backend-providers': [] };
  try { root = JSON.parse(value) as BERoot; } catch {}
  const provider: BEProvider = root['backend-providers']?.[0] ?? { 'class-name': '', settings: { legacy: false, backends: [] } };
  const backends: BEEntry[] = provider.settings?.backends ?? [];

  const save = (patch: Partial<BERoot>) => onChange(JSON.stringify({ ...root, ...patch }));
  const saveProvider = (patch: Partial<BEProvider>) => save({ 'backend-providers': [{ ...provider, ...patch }] });
  const saveSettings = (patch: Partial<BESettings>) => saveProvider({ settings: { ...provider.settings, ...patch } });
  const saveBackends = (list: BEEntry[]) => saveSettings({ backends: list });

  return (
    <div>
      <div className="adm-be-header-row mb-2">
        <div className="adm-be-header-field">
          <label className="adm-label adm-be-header-field__label">default-backend-id</label>
          <input className="adm-input" value={root['default-backend-id'] ?? ''}
            onChange={e => save({ 'default-backend-id': e.target.value })} />
        </div>
      </div>
      <div className="adm-be-header-row mb-3">
        <div className="adm-be-header-field adm-be-header-field--grow">
          <label className="adm-label adm-be-header-field__label">class-name</label>
          <input className="adm-input" value={provider['class-name'] ?? ''}
            onChange={e => saveProvider({ 'class-name': e.target.value })} />
        </div>
        <div className="adm-be-header-field">
          <BoolToggle
            value={provider.settings?.legacy ?? false}
            onChange={() => saveSettings({ legacy: !provider.settings?.legacy })}
            label="legacy"
          />
        </div>
      </div>
      <div className="adm-sub-label mb-2" style={{ justifyContent: 'space-between' }}>
        <span><i className="bi bi-diagram-3-fill" /> backends</span>
        <button type="button" className="adm-add-row-btn" style={{ marginBottom: 0 }}
          onClick={() => saveBackends([...backends, { ...EMPTY_ENTRY, 'zone-connection': { ...EMPTY_CONN }, 'transfer-connection': { ...EMPTY_CONN } }])}>
          <i className="bi bi-plus-lg" /> Add Backend
        </button>
      </div>
      <div className="adm-backend-list">
        {backends.map((b, i) => (
          <BackendItemCard key={i} entry={b} index={i}
            isDefault={b.id !== '' && b.id === root['default-backend-id']}
            open={openIdx === i}
            onOpen={() => onToggle(i)}
            onChange={updated => { const list = [...backends]; list[i] = updated; saveBackends(list); }}
            onRemove={backends.length > 1 ? () => saveBackends(backends.filter((_, j) => j !== i)) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AdminPage() {
  const { profile } = useProfile();
  const { addAlert } = useAlerts();

  // Config state
  const [flatConfig, setFlatConfig] = useState<Record<string, string>>(INITIAL_FLAT_CONFIG);
  const [expandedConfig, setExpandedConfig] = useState<ExpandedConfig | null>(null);
  // Tab overrides are stored in localStorage (browser-local, non-polluting)
  const userTabOverridesRef = useRef<Record<string, ConfigTab>>({});
  const [userTabOverrides, setUserTabOverrides] = useState<Record<string, ConfigTab>>({});
  // Tracks which API-level keys the user has edited since last fetch/save
  const dirtyApiKeys = useRef(new Set<string>());
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [createStatus, setCreateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [deleteStatus, setDeleteStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [deleteSelectMode, setDeleteSelectMode] = useState(false);
  const [selectedDeleteKeys, setSelectedDeleteKeys] = useState<Set<string>>(new Set());

  // Create modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createRows, setCreateRows] = useState<Array<{ tab: ConfigTab; key: string; value: string }>>([{ tab: 'boolean', key: '', value: 'false' }]);
  const [createSubmitAttempted, setCreateSubmitAttempted] = useState(false);
  const [activeTab, setActiveTab] = useState<ConfigTab>('boolean');
  const [pageTab, setPageTab] = useState<'config' | 'users'>('config');
  // Accordion: tracks which card index is open per array/json key (null = all collapsed)
  const [openCardIndex, setOpenCardIndex] = useState<Record<string, number | null>>({});
  const toggleCard = (key: string, i: number) =>
    setOpenCardIndex(prev => ({ ...prev, [key]: prev[key] === i ? null : i }));
  const [reloadStatus, setReloadStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [reloadMsg, setReloadMsg] = useState('');
  const [reloadPreviewOpen, setReloadPreviewOpen] = useState(false);
  const [reloadPreviewData, setReloadPreviewData] = useState<PendingChanges>({});
  const [reloadPreviewLoading, setReloadPreviewLoading] = useState(false);
  const [reloadConfirmStatus, setReloadConfirmStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [lockLoading, setLockLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [permLoading, setPermLoading] = useState(false);
  const [modalLoading, setModalLoading] = useState(false);

  // Panel A – Lock / Unlock
  const [lockUsername, setLockUsername] = useState('');
  const [lockAction, setLockAction] = useState<'lock' | 'unlock'>('lock');
  const [lockResult, setLockResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Panel B – Check Status
  const [statusUsername, setStatusUsername] = useState('');
  const [statusResult, setStatusResult] = useState<ManagedUser | 'notfound' | 'empty' | null>(null);

  // Panel C – Update Permission
  const [permUsername, setPermUsername] = useState('');
  const [permOp, setPermOp] = useState<PermOp>('MakeSuper');
  const [permResult, setPermResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const [confirmModal, setConfirmModal] = useState<{
    type: 'lock' | 'unlock' | 'role';
    permOp?: PermOp;
    user: ManagedUser;
  } | null>(null);

  // ── Config helpers ────────────────────────────────────────────────────────

  const fetchConfig = async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const entries = await getAllConfigs();
      const result = expandApiEntries(entries);
      dirtyApiKeys.current.clear();
      // Load overrides from localStorage, pruning any stale keys
      const overrides = loadTabOverrides();
      const liveKeys = new Set(Object.keys(result.flat));
      const pruned = Object.fromEntries(
        Object.entries(overrides).filter(([k]) => liveKeys.has(k)),
      ) as Record<string, ConfigTab>;
      userTabOverridesRef.current = pruned;
      // Persist pruned overrides back if any stale entries were removed
      if (Object.keys(pruned).length !== Object.keys(overrides).length) {
        saveTabOverrides(pruned);
      }
      setFlatConfig(result.flat);
      setExpandedConfig(result);
      setUserTabOverrides(pruned);
    } catch {
      setConfigError('Failed to load configuration. Please try again.');
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => { void fetchConfig(); }, []);

  const handleConfigUpdate = async () => {
    setUpdateStatus('loading');
    try {
      if (!expandedConfig) { setUpdateStatus('idle'); return; }
      const changedApiKeys = [...dirtyApiKeys.current];
      if (changedApiKeys.length === 0) {
        setUpdateStatus('idle');
        addAlert('info', 'No changes to save.');
        return;
      }
      const changedEntries = buildSavableEntries(changedApiKeys, flatConfig, expandedConfig);
      await updateAllConfigEntries(changedEntries);
      dirtyApiKeys.current.clear();
      setUpdateStatus('success');
      addAlert('success', 'Configuration saved successfully.');
      setTimeout(() => setUpdateStatus('idle'), 3000);
    } catch {
      setUpdateStatus('error');
      addAlert('danger', 'Failed to save configuration. Please try again.');
      setTimeout(() => setUpdateStatus('idle'), 3000);
    }
  };

  const handleConfigCreate = async () => {
    setCreateSubmitAttempted(true);
    const validRows = createRows.filter(r => r.key && r.value.trim() !== '');
    if (validRows.length < createRows.length) return;
    setCreateStatus('loading');
    try {
      const entries = validRows.map(r => ({ key: r.key, value: r.value }));
      await createAllConfigEntries(entries);
      // Remember which tab the user selected for each new key (persisted to API)
      for (const r of validRows) {
        if (r.tab) userTabOverridesRef.current[r.key] = r.tab as ConfigTab;
      }
      saveTabOverrides(userTabOverridesRef.current);
      // Switch to the tab of the first created key
      const firstTab = validRows[0]?.tab;
      if (firstTab) setActiveTab(firstTab);
      setCreateStatus('success');
      addAlert('success', `Created ${entries.length} config entr${entries.length === 1 ? 'y' : 'ies'} successfully.`);
      setCreateModalOpen(false);
      setCreateRows([{ tab: 'boolean', key: '', value: 'false' }]);
      setCreateSubmitAttempted(false);
      void fetchConfig();
      setTimeout(() => setCreateStatus('idle'), 3000);
    } catch (err: unknown) {
      setCreateStatus('error');
      let msg = 'Failed to create configuration. Please try again.';
      if (err && typeof err === 'object') {
        const e = err as { response?: { data?: unknown }; message?: string };
        const d = e.response?.data;
        if (typeof d === 'string' && d.trim()) msg = d.trim();
        else if (d && typeof d === 'object') {
          const od = d as { message?: string; error?: string };
          msg = od.message ?? od.error ?? e.message ?? msg;
        } else if (e.message) {
          msg = e.message;
        }
      }
      addAlert('danger', msg);
      setTimeout(() => setCreateStatus('idle'), 3000);
    }
  };

  const handleConfigDelete = async () => {
    if (selectedDeleteKeys.size === 0) return;
    setDeleteStatus('loading');
    const apiKeysToDelete = [...new Set([...selectedDeleteKeys].map(k => flatKeyToApiKey(k, expandedConfig?.reverseMap ?? {})))];
    try {
      for (const k of apiKeysToDelete) { await deleteConfigEntry(k); }
      setDeleteStatus('success');
      addAlert('success', `Deleted ${apiKeysToDelete.length} key(s) successfully.`);
      setDeleteSelectMode(false);
      setSelectedDeleteKeys(new Set());
      void fetchConfig();
      setTimeout(() => setDeleteStatus('idle'), 3000);
    } catch {
      setDeleteStatus('error');
      addAlert('danger', 'Failed to delete config. Please try again.');
      setDeleteSelectMode(false);
      setSelectedDeleteKeys(new Set());
      setTimeout(() => setDeleteStatus('idle'), 3000);
    }
  };

  // ── Flat config helpers ─────────────────────────────────────────────────────

  const setKey = (k: string, v: string) => {
    dirtyApiKeys.current.add(flatKeyToApiKey(k, expandedConfig?.reverseMap ?? {}));
    setFlatConfig(c => ({ ...c, [k]: v }));
  };
  const bool  = (k: string) => flatConfig[k] === 'true';
  const toggleBool = (k: string) => setKey(k, bool(k) ? 'false' : 'true');

  const handleReload = async () => {
    setReloadPreviewLoading(true);
    try {
      const pending = await fetchEffectiveConfig();
      if (Object.keys(pending).length === 0) {
        addAlert('info', 'Config is up to date. No pending changes to apply.');
        return;
      }
      setReloadPreviewData(pending);
      setReloadPreviewOpen(true);
    } catch {
      addAlert('danger', 'Failed to fetch effective configuration. Please try again.');
    } finally {
      setReloadPreviewLoading(false);
    }
  };

  const handleConfirmReload = async () => {
    setReloadConfirmStatus('loading');
    try {
      const result = await reloadAppConfig();
      setReloadStatus('success');
      setReloadMsg(result.message ?? 'Configuration reloaded successfully.');
      setReloadPreviewOpen(false);
      setReloadConfirmStatus('idle');
      void fetchConfig();
      setTimeout(() => setReloadStatus('idle'), 4000);
    } catch {
      setReloadConfirmStatus('error');
      setReloadMsg('Failed to reload configuration. Please try again.');
      setTimeout(() => { setReloadConfirmStatus('idle'); setReloadStatus('error'); }, 4000);
    }
  };

  // ── User action handlers ──────────────────────────────────────────────────

  const handleLockSubmit = async () => {
    const q = lockUsername.trim();
    if (!q) { setLockResult({ ok: false, msg: 'Username is mandatory.' }); return; }
    setLockLoading(true);
    setLockResult(null);
    try {
      const res = await adminService.getUserByIdOrName(q);
      const found = toManagedUser(res.data);
      if (!found) { setLockResult({ ok: false, msg: `User "${q}" not found.` }); return; }
      if (lockAction === 'lock' && found.lockStatus === 'Locked') {
        setLockResult({ ok: false, msg: `"${found.userName}" is already locked.` }); return;
      }
      if (lockAction === 'unlock' && found.lockStatus === 'Unlocked') {
        setLockResult({ ok: false, msg: `"${found.userName}" is already unlocked.` }); return;
      }
      setConfirmModal({ type: lockAction, user: found });
    } catch {
      setLockResult({ ok: false, msg: 'Failed to look up user. Please try again.' });
    } finally {
      setLockLoading(false);
    }
  };

  const handleStatusCheck = async () => {
    const q = statusUsername.trim();
    if (!q) { setStatusResult('empty'); return; }
    setStatusLoading(true);
    setStatusResult(null);
    try {
      const res = await adminService.getUserByIdOrName(q);
      const found = toManagedUser(res.data);
      setStatusResult(found ?? 'notfound');
    } catch {
      setStatusResult('notfound');
    } finally {
      setStatusLoading(false);
    }
  };

  const handlePermSubmit = async () => {
    const q = permUsername.trim();
    if (!q) { setPermResult({ ok: false, msg: 'Username is mandatory.' }); return; }
    setPermLoading(true);
    setPermResult(null);
    try {
      const res = await adminService.getUserByIdOrName(q);
      const found = toManagedUser(res.data);
      if (!found) { setPermResult({ ok: false, msg: `User "${q}" not found.` }); return; }
      if (permOp === 'MakeSuper' && found.isSuper) {
        setPermResult({ ok: false, msg: `"${found.userName}" is already a Super User.` }); return;
      }
      if (permOp === 'RemoveSuper' && !found.isSuper) {
        setPermResult({ ok: false, msg: `"${found.userName}" is not a Super User.` }); return;
      }
      if (permOp === 'MakeSupport' && found.isSupport) {
        setPermResult({ ok: false, msg: `"${found.userName}" is already a Support User.` }); return;
      }
      if (permOp === 'RemoveSupport' && !found.isSupport) {
        setPermResult({ ok: false, msg: `"${found.userName}" is not a Support User.` }); return;
      }
      setConfirmModal({ type: 'role', user: found, permOp });
    } catch {
      setPermResult({ ok: false, msg: 'Failed to look up user. Please try again.' });
    } finally {
      setPermLoading(false);
    }
  };

  const handleModalConfirm = async () => {
    if (!confirmModal) return;
    setModalLoading(true);
    try {
      const { type, user } = confirmModal;
      if (type === 'lock') {
        await adminService.lockUser(user.id);
        setLockResult({ ok: true, msg: `"${user.userName}" has been locked successfully.` });
      } else if (type === 'unlock') {
        await adminService.unlockUser(user.id);
        setLockResult({ ok: true, msg: `"${user.userName}" has been unlocked successfully.` });
      } else if (type === 'role' && confirmModal.permOp) {
        await adminService.updatePermission(user.id, confirmModal.permOp);
        setPermResult({ ok: true, msg: `Permission updated: ${PERM_OP_LABELS[confirmModal.permOp]} applied to "${user.userName}".` });
      }
      setConfirmModal(null);
    } catch {
      setLockResult({ ok: false, msg: 'Action failed. Please try again.' });
      setConfirmModal(null);
    } finally {
      setModalLoading(false);
    }
  };

  // ── Visible tabs — driven entirely by keys returned from GET /appconfig ───

  // ── Derived tabs — computed from actual flat config, no hardcoded key lists ──

  const { tabs: derivedTabs, tabKeyMap } = useMemo(
    () => deriveTabsFromFlat(flatConfig, expandedConfig?.reverseMap ?? {}, userTabOverrides),
    [flatConfig, expandedConfig, userTabOverrides],
  );

  const visibleTabs = useMemo(
    () => derivedTabs.filter(t => (tabKeyMap[t.id] ?? []).some(k => k in flatConfig)),
    [derivedTabs, tabKeyMap, flatConfig],
  );

  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.some(t => t.id === activeTab)) {
      setActiveTab(visibleTabs[0].id);
    }
  }, [visibleTabs]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="adm-page">
        {/* ═══ HERO HEADER ═══════════════════════════════════════════════════════ */}
      <div className="adm-hero">
        <div className="adm-hero__text">
          <div className="adm-hero__eyebrow">
            <i className="bi bi-shield-shaded" /> System Administration
          </div>
          <h1 className="adm-hero__title">Admin Control Panel</h1>
        </div>
        <div className="adm-hero__actions">
          {pageTab === 'config' && (
            <button
              className={`adm-reload-btn${reloadPreviewLoading ? ' adm-reload-btn--loading' : ''}${reloadStatus === 'success' ? ' adm-reload-btn--success' : ''}${reloadStatus === 'error' ? ' adm-reload-btn--error' : ''}`}
              onClick={() => void handleReload()}
              disabled={reloadPreviewLoading}
            >
              <i className={`bi ${reloadStatus === 'success' ? 'bi-check2-circle' : reloadStatus === 'error' ? 'bi-exclamation-circle' : 'bi-arrow-clockwise'} adm-reload-btn__icon`} />
              <span>
                {reloadPreviewLoading ? 'Loading preview…'
                  : reloadStatus === 'success' ? 'Reloaded!'
                  : reloadStatus === 'error' ? 'Failed'
                  : 'Reload Config'}
              </span>
            </button>
          )}
        </div>
      </div>

      {(reloadStatus === 'success' || reloadStatus === 'error') && (
        <div className={`adm-toast adm-toast--${reloadStatus === 'error' ? 'error' : 'success'}`}>
          <i className={`bi ${reloadStatus === 'error' ? 'bi-exclamation-circle-fill' : 'bi-check-circle-fill'}`} /> {reloadMsg}
        </div>
      )}

      {/* ═══ PAGE-LEVEL TABS ════════════════════════════════════════════════════ */}
      <div className="vds-pill-toggle">
        <button type="button"
          className={`vds-pill-toggle__btn${pageTab === 'config' ? ' vds-pill-toggle__btn--active' : ''}`}
          onClick={() => setPageTab('config')}
        >
          <i className="bi bi-sliders2" /> Configuration
        </button>
        <button type="button"
          className={`vds-pill-toggle__btn${pageTab === 'users' ? ' vds-pill-toggle__btn--active' : ''}`}
          onClick={() => setPageTab('users')}
        >
          <i className="bi bi-people-fill" /> User Access
        </button>
      </div>

      {/* ═══ SECTION 1 – CONFIG ════════════════════════════════════════════════ */}
      {pageTab === 'config' && <section className="adm-section">
        <div className="adm-section__header">
          <div className="adm-section__title">
            <div className="adm-section__title-left">
              <span className="adm-section__icon adm-section__icon--blue">
                <i className="bi bi-sliders2" />
              </span>
              Configuration Profile
            </div>
            <div className="adm-btn-group">
              <button
                className={`adm-create-btn${createStatus === 'loading' ? ' adm-create-btn--loading' : ''}${createStatus === 'success' ? ' adm-create-btn--success' : ''}${createStatus === 'error' ? ' adm-create-btn--error' : ''}`}
                onClick={() => { setCreateRows([{ tab: 'boolean', key: '', value: 'false' }]); setCreateSubmitAttempted(false); setCreateModalOpen(true); }}
                disabled={createStatus === 'loading' || configLoading || deleteSelectMode}
              >
                <i className={`bi ${createStatus === 'success' ? 'bi-check2-circle' : createStatus === 'error' ? 'bi-exclamation-circle' : 'bi-plus-circle-fill'}`} />
                {' '}{createStatus === 'loading' ? 'Creating…' : createStatus === 'success' ? 'Created!' : createStatus === 'error' ? 'Failed' : 'Create'}
              </button>
              <button
                className={`adm-update-btn${updateStatus === 'loading' ? ' adm-update-btn--loading' : ''}${updateStatus === 'success' ? ' adm-update-btn--success' : ''}${updateStatus === 'error' ? ' adm-update-btn--error' : ''}`}
                onClick={() => void handleConfigUpdate()}
                disabled={updateStatus === 'loading' || configLoading || deleteSelectMode}
              >
                <i className={`bi ${updateStatus === 'success' ? 'bi-check2-circle' : updateStatus === 'error' ? 'bi-exclamation-circle' : 'bi-floppy-fill'}`} />
                {' '}{updateStatus === 'loading' ? 'Saving…' : updateStatus === 'success' ? 'Saved!' : updateStatus === 'error' ? 'Failed' : 'Update'}
              </button>
              {!deleteSelectMode ? (
                <button
                  className={`adm-delete-btn${deleteStatus === 'loading' ? ' adm-delete-btn--loading' : ''}${deleteStatus === 'success' ? ' adm-delete-btn--success' : ''}${deleteStatus === 'error' ? ' adm-delete-btn--error' : ''}`}
                  onClick={() => { setDeleteSelectMode(true); setSelectedDeleteKeys(new Set()); }}
                  disabled={deleteStatus === 'loading' || configLoading}
                >
                  <i className={`bi ${deleteStatus === 'success' ? 'bi-check2-circle' : deleteStatus === 'error' ? 'bi-exclamation-circle' : 'bi-trash3-fill'}`} />
                  {' '}{deleteStatus === 'loading' ? 'Deleting…' : deleteStatus === 'success' ? 'Deleted!' : deleteStatus === 'error' ? 'Failed' : 'Delete'}
                </button>
              ) : (
                <>
                  <button
                    className="adm-btn adm-btn--ghost"
                    onClick={() => { setDeleteSelectMode(false); setSelectedDeleteKeys(new Set()); }}
                  >
                    <i className="bi bi-x-lg" /> Cancel
                  </button>
                  <button
                    className="adm-delete-btn"
                    onClick={() => void handleConfigDelete()}
                    disabled={selectedDeleteKeys.size === 0 || deleteStatus === 'loading'}
                  >
                    <i className="bi bi-trash3-fill" /> Delete ({selectedDeleteKeys.size})
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="adm-section__desc">
            Edit configuration values by tab. <strong>Update</strong> saves changes; <strong>Create</strong> initialises all keys; click <strong>Delete</strong> to select which keys to remove. Click <strong>Reload Config</strong> to apply changes at runtime.
          </div>
        </div>

        {/* Tabs */}
        <div className={`adm-tabs${configLoading ? ' d-none' : ''}`}>
          {visibleTabs.map(t => (
            <button
              key={t.id}
              className={`adm-tab${activeTab === t.id ? ' adm-tab--active' : ''}`}
              data-tab={t.id}
              onClick={() => setActiveTab(t.id)}
            >
              <i className={`bi ${t.icon}`} />
              <span className="adm-tab__label">{t.label}</span>
            </button>
          ))}
        </div>

        {/* Delete key selector — shown below tabs */}
        {deleteSelectMode && !configLoading && (
          <div className="adm-delete-select-bar">
            <div className="adm-delete-select-bar__label">
              <i className="bi bi-trash3-fill" /> Select keys to delete:
            </div>
            <div className="adm-delete-select-bar__keys">
              {(tabKeyMap[activeTab] ?? []).filter(k => k in flatConfig).map(k => (
                <label key={k} className={`adm-delete-key-check${selectedDeleteKeys.has(k) ? ' adm-delete-key-check--selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedDeleteKeys.has(k)}
                    onChange={e => {
                      const next = new Set(selectedDeleteKeys);
                      if (e.target.checked) next.add(k); else next.delete(k);
                      setSelectedDeleteKeys(next);
                    }}
                  />
                  {k}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="adm-tab-panel">

          {configLoading && (
            <div className="adm-config-loading">
              <div className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true" />
              Loading configuration…
            </div>
          )}
          {configError && (
            <div className="adm-inline-msg adm-inline-msg--err">
              <i className="bi bi-exclamation-circle-fill adm-inline-msg__icon" />
              <span className="adm-inline-msg__text">{configError}</span>
              <button className="adm-inline-msg__retry" onClick={() => void fetchConfig()}>Retry</button>
            </div>
          )}


          {/* BOOLEAN */}
          {!configLoading && activeTab === 'boolean' && (
            <div>
              <div className="row g-2">
                {(tabKeyMap['boolean'] ?? []).filter(k => k in flatConfig).map(k => (
                  <div key={k} className="col-md-6">
                    <BoolToggle value={flatConfig[k] === 'true'} onChange={() => toggleBool(k)} label={k} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* NUMERIC */}
          {!configLoading && activeTab === 'numeric' && (
            <div>
              <div className="row g-2">
                {(tabKeyMap['numeric'] ?? []).filter(k => k in flatConfig).map(k => (
                  <div key={k} className="col-sm-6 col-md-4 col-lg-3">
                    <div className="adm-form-group">
                      <label className="adm-label" style={{ fontSize: '0.68rem' }}>{k}</label>
                      <input className="adm-input" type="number" value={flatConfig[k] ?? ''} onChange={e => setKey(k, e.target.value)} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STRING */}
          {!configLoading && activeTab === 'string' && (
            <div>
              <div className="row g-3">
                {(tabKeyMap['string'] ?? []).filter(k => k in flatConfig).map(k => (
                  <div key={k} className="col-md-8">
                    <div className="adm-form-group">
                      <label className="adm-label">{k}</label>
                      <textarea className="adm-input adm-input--wrap" value={flatConfig[k] ?? ''} onChange={e => setKey(k, e.target.value)} rows={1} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ARRAY */}
          {!configLoading && activeTab === 'array' && (
            <div className="d-flex flex-column gap-3">
              {(tabKeyMap['array'] ?? []).filter(k => k in flatConfig).map(k => {
                let arr: unknown[] = [];
                let arrParseOk = false;
                try { const p = JSON.parse(flatConfig[k]); if (Array.isArray(p)) { arr = p; arrParseOk = true; } } catch {}
                if (!arrParseOk) return (
                  <div key={k} className="adm-array-card">
                    <div className="adm-array-card__header">
                      <div className="adm-sub-label"><i className="bi bi-list-ul" /> {k}</div>
                    </div>
                    <textarea className="adm-input adm-input--wrap" value={flatConfig[k] ?? ''} rows={3}
                      onChange={e => setKey(k, e.target.value)}
                      placeholder='["value1","value2"]' />
                  </div>
                );
                const isPrimitive = arr.every(item => typeof item !== 'object' || item === null);
                return (
                  <div key={k} className="adm-array-card">
                    <div className="adm-array-card__header">
                      <div className="adm-sub-label"><i className="bi bi-list-ul" /> {k}</div>
                      {!isPrimitive && (
                        <button type="button" className="adm-add-row-btn" style={{ marginBottom: 0 }}
                          onClick={() => {
                            // Clone structure of first item with empty values so fields appear
                            const template = arr[0] && typeof arr[0] === 'object' && arr[0] !== null
                              ? Object.fromEntries(Object.entries(arr[0] as Record<string, unknown>).map(
                                  ([field, val]) => [field, Array.isArray(val) ? [] : typeof val === 'number' ? 0 : ''],
                                ))
                              : {};
                            setKey(k, JSON.stringify([...arr, template]));
                          }}>
                          <i className="bi bi-plus-lg" /> Add Item
                        </button>
                      )}
                    </div>
                    {isPrimitive ? (
                      <div style={{ maxWidth: '560px' }}>
                        <TagInput
                          tags={arr as string[]}
                          onChange={v => setKey(k, JSON.stringify(v))}
                          placeholder={`Add to ${k}…`}
                        />
                      </div>
                    ) : (
                      <div className="adm-backend-list mt-2">
                        {arr.map((item, i) => (
                          <AclRuleCard
                            key={i}
                            rule={item as Record<string, unknown>}
                            index={i}
                            open={openCardIndex[k] === i}
                            onOpen={() => toggleCard(k, i)}
                            onChange={updated => {
                              const newArr = [...arr];
                              newArr[i] = updated;
                              setKey(k, JSON.stringify(newArr));
                            }}
                            onRemove={arr.length > 1 ? () => setKey(k, JSON.stringify(arr.filter((_, j) => j !== i))) : undefined}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* JSON */}
          {!configLoading && activeTab === 'json' && (
            <div className="d-flex flex-column gap-3">
              {(tabKeyMap['json'] ?? []).filter(k => k in flatConfig).map(k => {
                let obj: Record<string, unknown> = {};
                let jsonParseOk = false;
                try { const p = JSON.parse(flatConfig[k]); if (typeof p === 'object' && p !== null && !Array.isArray(p)) { obj = p as Record<string, unknown>; jsonParseOk = true; } } catch {}
                if (!jsonParseOk) return (
                  <div key={k} className="adm-array-card">
                    <div className="adm-array-card__header">
                      <div className="adm-sub-label"><i className="bi bi-braces" /> {k}</div>
                    </div>
                    <textarea className="adm-input adm-input--wrap" value={flatConfig[k] ?? ''} rows={4}
                      onChange={e => setKey(k, e.target.value)}
                      placeholder='{"key":"value"}' />
                  </div>
                );
                return (
                  <div key={k} className="adm-array-card">
                    <div className="adm-array-card__header">
                      <div className="adm-sub-label"><i className="bi bi-braces" /> {k}</div>
                    </div>
                    {'backend-providers' in obj ? (
                      <BackendEditor value={flatConfig[k]} onChange={v => setKey(k, v)}
                        openIdx={openCardIndex[k] ?? null}
                        onToggle={i => toggleCard(k, i)} />
                    ) : (
                    <div className="row g-3">
                      {Object.entries(obj).map(([field, val]) => {
                        if (Array.isArray(val)) {
                          const hasObjects = val.some(item => typeof item === 'object' && item !== null);
                          // derive a contextual label from the field name
                          const itemLabel = field.includes('backend') ? 'Backend'
                            : field.includes('setting') ? 'Entry'
                            : field.includes('rule') ? 'Rule'
                            : 'Item';
                          // build a blank template from the first item's structure
                          const cloneTemplate = (src: unknown[]): Record<string, unknown> =>
                            src[0] && typeof src[0] === 'object' && src[0] !== null
                              ? Object.fromEntries(Object.entries(src[0] as Record<string, unknown>).map(
                                  ([fk, fv]) => [fk, Array.isArray(fv) ? [] : typeof fv === 'number' ? 0 : ''],
                                ))
                              : {};
                          if (hasObjects) {
                            return (
                              <div key={field} className="col-12">
                                <div className="adm-sub-label mb-2" style={{ justifyContent: 'space-between' }}>
                                  <span><i className="bi bi-list-ul" /> {field}</span>
                                  <button type="button" className="adm-add-row-btn" style={{ marginBottom: 0 }}
                                    onClick={() => {
                                      let cur: Record<string, unknown> = {};
                                      try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                      setKey(k, JSON.stringify({ ...cur, [field]: [...val, cloneTemplate(val)] }));
                                    }}>
                                    <i className="bi bi-plus-lg" /> Add Item
                                  </button>
                                </div>
                                <div className="adm-backend-list">
                                  {(val as Record<string, unknown>[]).map((item, i) => (
                                    <AclRuleCard key={i} rule={item} index={i} label={itemLabel}
                                      open={openCardIndex[`${k}.${field}`] === i}
                                      onOpen={() => toggleCard(`${k}.${field}`, i)}
                                      onChange={updated => {
                                        let cur: Record<string, unknown> = {};
                                        try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                        const newArr = [...(cur[field] as unknown[])];
                                        newArr[i] = updated;
                                        setKey(k, JSON.stringify({ ...cur, [field]: newArr }));
                                      }}
                                      onRemove={val.length > 1 ? () => {
                                        let cur: Record<string, unknown> = {};
                                        try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                        setKey(k, JSON.stringify({ ...cur, [field]: (val as unknown[]).filter((_, j) => j !== i) }));
                                      } : undefined}
                                    />
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div key={field} className="col-md-8">
                              <div className="adm-form-group">
                                <label className="adm-label">{field}</label>
                                <TagInput
                                  tags={val as string[]}
                                  onChange={v => {
                                    let cur: Record<string, unknown> = {};
                                    try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                    setKey(k, JSON.stringify({ ...cur, [field]: v }));
                                  }}
                                  placeholder={`Add ${field}…`}
                                />
                              </div>
                            </div>
                          );
                        }
                        if (typeof val === 'boolean') {
                          return (
                            <div key={field} className="col-md-6">
                              <BoolToggle
                                value={val}
                                onChange={() => {
                                  let cur: Record<string, unknown> = {};
                                  try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                  setKey(k, JSON.stringify({ ...cur, [field]: !val }));
                                }}
                                label={field}
                              />
                            </div>
                          );
                        }
                        if (typeof val === 'object' && val !== null) {
                          return (
                            <div key={field} className="col-12">
                              <div className="adm-form-group">
                                <label className="adm-label">{field}</label>
                                <textarea
                                  className="adm-input"
                                  rows={4}
                                  value={JSON.stringify(val, null, 2)}
                                  onChange={e => {
                                    try {
                                      const parsed: unknown = JSON.parse(e.target.value);
                                      let cur: Record<string, unknown> = {};
                                      try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                      setKey(k, JSON.stringify({ ...cur, [field]: parsed }));
                                    } catch { /* ignore invalid JSON while typing */ }
                                  }}
                                />
                              </div>
                            </div>
                          );
                        }
                        const isNum = typeof val === 'number';
                        return (
                          <div key={field} className={isNum ? 'col-md-4' : 'col-md-8'}>
                            <div className="adm-form-group">
                              <label className="adm-label">{field}</label>
                              <input
                                className="adm-input"
                                type={isNum ? 'number' : 'text'}
                                value={String(val ?? '')}
                                onChange={e => {
                                  let cur: Record<string, unknown> = {};
                                  try { cur = JSON.parse(flatConfig[k]) as Record<string, unknown>; } catch {}
                                  setKey(k, JSON.stringify({ ...cur, [field]: isNum ? (parseFloat(e.target.value) || 0) : e.target.value }));
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        </div>
      </section>}


      {/* ═══ SECTION 2 – USER MANAGEMENT ══════════════════════════════════════ */}
      {pageTab === 'users' && <section className="adm-section">
        <div className="adm-section__header">
            <div className="adm-section__title">
              <div className="adm-section__title-left">
                <span className="adm-section__icon adm-section__icon--violet">
                  <i className="bi bi-people-fill" />
                </span>
                User Access Management
              </div>
            </div>
            <div className="adm-section__desc">
              Manage user lock status and permissions by username.
            </div>
          </div>

          <div className="adm-action-grid">

            {/* ── Panel A: Lock / Unlock ─────────────────────────────────── */}
            <div className="adm-action-panel adm-action-panel--lock">
              <div className="adm-action-panel__header">
                <div className="adm-action-panel__icon-wrap">
                  <i className="bi bi-lock-fill" />
                </div>
                <div>
                  <div className="adm-action-panel__title">Lock / Unlock User</div>
                  <div className="adm-action-panel__sub">Enable or disable a user's access</div>
                </div>
              </div>

              <div className="adm-action-panel__body">
                <label className="adm-label">Username</label>
                <div className="adm-input-wrap">
                  <i className="bi bi-person-fill adm-input-wrap__icon" />
                  <input
                    className="adm-input adm-input--icon"
                    placeholder="Enter the username"
                    value={lockUsername}
                    onChange={e => { setLockUsername(e.target.value); setLockResult(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') void handleLockSubmit(); }}
                  />
                </div>

                <label className="adm-label mt-3">Select Action</label>
                <div className="adm-radio-group">
                  <label className={`adm-radio${lockAction === 'lock' ? ' adm-radio--active adm-radio--red' : ''}`}>
                    <input type="radio" name="lockAction" value="lock" checked={lockAction === 'lock'}
                      onChange={() => setLockAction('lock')} />
                    <span className="adm-radio__dot" />
                    <i className="bi bi-lock-fill" />
                    Lock
                  </label>
                  <label className={`adm-radio${lockAction === 'unlock' ? ' adm-radio--active adm-radio--green' : ''}`}>
                    <input type="radio" name="lockAction" value="unlock" checked={lockAction === 'unlock'}
                      onChange={() => setLockAction('unlock')} />
                    <span className="adm-radio__dot" />
                    <i className="bi bi-unlock-fill" />
                    Unlock
                  </label>
                </div>

                {lockResult && (
                  <div className={`adm-inline-msg mt-3 ${lockResult.ok ? 'adm-inline-msg--ok' : 'adm-inline-msg--err'}`}>
                    <i className={`bi ${lockResult.ok ? 'bi-check-circle-fill' : 'bi-exclamation-circle-fill'}`} />
                    {lockResult.msg}
                  </div>
                )}
              </div>

              <div className="adm-action-panel__footer">
                <button className="adm-panel-btn adm-panel-btn--primary" onClick={() => void handleLockSubmit()} disabled={lockLoading}>
                  {lockLoading
                    ? <><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Checking…</>
                    : <><i className="bi bi-send-fill" /> Submit</>}
                </button>
                <button className="adm-panel-btn adm-panel-btn--ghost" onClick={() => { setLockUsername(''); setLockAction('lock'); setLockResult(null); }}>
                  <i className="bi bi-x-lg" /> Clear
                </button>
              </div>
            </div>

            {/* ── Panel B: Check Status ──────────────────────────────────── */}
            <div className="adm-action-panel adm-action-panel--status">
              <div className="adm-action-panel__header">
                <div className="adm-action-panel__icon-wrap adm-action-panel__icon-wrap--blue">
                  <i className="bi bi-person-lines-fill" />
                </div>
                <div>
                  <div className="adm-action-panel__title">Check User Status</div>
                  <div className="adm-action-panel__sub">View role, lock state &amp; permissions</div>
                </div>
              </div>

              <div className="adm-action-panel__body">
                <label className="adm-label">Username</label>
                <div className="adm-input-wrap">
                  <i className="bi bi-search adm-input-wrap__icon" />
                  <input
                    className="adm-input adm-input--icon"
                    placeholder="Enter the username"
                    value={statusUsername}
                    onChange={e => { setStatusUsername(e.target.value); setStatusResult(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') void handleStatusCheck(); }}
                  />
                </div>

                {/* Result */}
                                {statusResult === 'empty' && (
                  <div className="adm-inline-msg adm-inline-msg--err mt-3">
                    <i className="bi bi-exclamation-circle-fill" /> Username is mandatory.
                  </div>
                )}

                {statusResult === 'notfound' && (
                  <div className="adm-inline-msg adm-inline-msg--err mt-3">
                    <i className="bi bi-person-x-fill" /> User <strong>{statusUsername}</strong> not found.
                  </div>
                )}

                {statusResult && statusResult !== 'notfound' && statusResult !== 'empty' && (() => {
                  const u = statusResult;
                  const role = getRoleFromUser(u);
                  const rm = roleMeta(role);
                  const isLocked = u.lockStatus === 'Locked';
                  return (
                    <div className="adm-status-card">
                      <div className="adm-status-card__row">
                        <div className={`adm-avatar adm-avatar--${role} adm-avatar--lg`}>{initials(u)}</div>
                        <div>
                          <div className="adm-status-card__name">{u.userName}</div>
                          <div className="adm-status-card__full">{u.firstName} {u.lastName}</div>
                          <div className="adm-status-card__email">{u.email}</div>
                        </div>
                      </div>
                      <div className="adm-status-card__pills">
                        <span className={`adm-status ${isLocked ? 'adm-status--locked' : 'adm-status--active'}`}>
                          <i className={`bi ${isLocked ? 'bi-lock-fill' : 'bi-unlock-fill'}`} />
                          {u.lockStatus}
                        </span>
                        <span className={rm.cls}>
                          <i className={`bi ${rm.icon}`} /> {rm.label}
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>

              <div className="adm-action-panel__footer">
                <button className="adm-panel-btn adm-panel-btn--blue" onClick={() => void handleStatusCheck()} disabled={statusLoading}>
                  {statusLoading
                    ? <><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Checking…</>
                    : <><i className="bi bi-binoculars-fill" /> Check Status</>}
                </button>
                <button className="adm-panel-btn adm-panel-btn--ghost" onClick={() => { setStatusUsername(''); setStatusResult(null); }}>
                  <i className="bi bi-x-lg" /> Clear
                </button>
              </div>
            </div>

            {/* ── Panel C: Update Permission ─────────────────────────────────────── */}
            <div className="adm-action-panel adm-action-panel--perm">
              <div className="adm-action-panel__header">
                <div className="adm-action-panel__icon-wrap adm-action-panel__icon-wrap--violet">
                  <i className="bi bi-shield-lock-fill" />
                </div>
                <div>
                  <div className="adm-action-panel__title">Update Permission</div>
                  <div className="adm-action-panel__sub">Assign a role to any user</div>
                </div>
              </div>

              <div className="adm-action-panel__body">
                <label className="adm-label">Username</label>
                <div className="adm-input-wrap">
                  <i className="bi bi-person-fill adm-input-wrap__icon" />
                  <input
                    className="adm-input adm-input--icon"
                    placeholder="Enter the username"
                    value={permUsername}
                    onChange={e => { setPermUsername(e.target.value); setPermResult(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') void handlePermSubmit(); }}
                  />
                </div>

                <label className="adm-label mt-3">Select Permission</label>
                <div className="adm-perm-radio-group">
                  {([
                    { value: 'MakeSuper'     as PermOp, label: 'Make Super User',    icon: 'bi-shield-fill-check',  mod: 'super'   },
                    { value: 'RemoveSuper'   as PermOp, label: 'Remove Super User',  icon: 'bi-shield-slash-fill',  mod: 'normal'  },
                    { value: 'MakeSupport'   as PermOp, label: 'Make Support User',  icon: 'bi-headset',            mod: 'support' },
                    { value: 'RemoveSupport' as PermOp, label: 'Remove Support User',icon: 'bi-person-dash-fill',   mod: 'normal'  },
                  ]).map(opt => (
                    <label
                      key={opt.value}
                      className={`adm-perm-radio adm-perm-radio--${opt.mod}${permOp === opt.value ? ' adm-perm-radio--active' : ''}`}
                    >
                      <input type="radio" name="permOp" value={opt.value} checked={permOp === opt.value}
                        onChange={() => setPermOp(opt.value)} />
                      <span className="adm-perm-radio__dot" />
                      <i className={`bi ${opt.icon} adm-perm-radio__ico`} />
                      {opt.label}
                    </label>
                  ))}
                </div>

                {permResult && (
                  <div className={`adm-inline-msg mt-3 ${permResult.ok ? 'adm-inline-msg--ok' : 'adm-inline-msg--err'}`}>
                    <i className={`bi ${permResult.ok ? 'bi-check-circle-fill' : 'bi-exclamation-circle-fill'}`} />
                    {permResult.msg}
                  </div>
                )}
              </div>

              <div className="adm-action-panel__footer">
                <button className="adm-panel-btn adm-panel-btn--violet" onClick={() => void handlePermSubmit()} disabled={permLoading}>
                  {permLoading
                    ? <><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" /> Checking…</>
                    : <><i className="bi bi-send-fill" /> Submit</>}
                </button>
                <button className="adm-panel-btn adm-panel-btn--ghost" onClick={() => { setPermUsername(''); setPermOp('MakeSuper'); setPermResult(null); }}>
                  <i className="bi bi-x-lg" /> Clear
                </button>
              </div>
            </div>

          </div>

      </section>}

      {/* ═══ CONFIRM MODAL ════════════════════════════════════════════════════ */}
      {confirmModal && (() => {
        const user = confirmModal.user;
        const isLockAction = confirmModal.type === 'lock' || confirmModal.type === 'unlock';
        const isLock = confirmModal.type === 'lock';

        return (
          <div className="adm-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setConfirmModal(null); }}>
            <div className="adm-modal">
              <div className="adm-modal__header">
                <div className={`adm-modal__icon adm-modal__icon--${isLockAction ? (isLock ? 'red' : 'green') : 'blue'}`}>
                  <i className={`bi ${isLockAction ? (isLock ? 'bi-lock-fill' : 'bi-unlock-fill') : 'bi-shield-fill-check'}`} />
                </div>
                <span className="adm-modal__title">
                  {isLockAction
                    ? `${isLock ? 'Lock' : 'Unlock'} user "${user.userName}"?`
                    : `Change permission for "${user.userName}"?`}
                </span>
                <button className="adm-modal__close" onClick={() => setConfirmModal(null)} aria-label="Close">
                  <i className="bi bi-x-lg" />
                </button>
              </div>
              <div className="adm-modal__body">
                {isLockAction ? (
                  <p>
                    {isLock
                      ? 'Locking this user will prevent them from logging in and using the API. They can be unlocked at any time.'
                      : 'Unlocking will restore full access for this user immediately.'}
                  </p>
                ) : (
                  <p>
                    You are about to <strong>{confirmModal.permOp ? PERM_OP_LABELS[confirmModal.permOp] : ''}</strong> for{' '}
                    <strong>{user.userName}</strong>.
                    This affects their permissions across the entire system.
                  </p>
                )}
              </div>
              <div className="adm-modal__footer">
                <button className="adm-btn adm-btn--ghost" onClick={() => setConfirmModal(null)}>
                  Cancel
                </button>
                <button
                  className={`adm-btn ${isLockAction ? (isLock ? 'adm-btn--danger' : 'adm-btn--success') : 'adm-btn--primary'}`}
                  onClick={() => void handleModalConfirm()}
                  disabled={modalLoading}
                >
                  {modalLoading
                    ? <><div className="spinner-border spinner-border-sm" role="status" /> Working…</>
                    : <><i className={`bi ${isLockAction ? (isLock ? 'bi-lock-fill' : 'bi-unlock-fill') : 'bi-check2-circle'}`} /> Confirm</>}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ CREATE CONFIG MODAL ══════════════════════════════════════════════ */}
      {createModalOpen && (
        <div className="adm-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setCreateModalOpen(false); }}>
          <div className="adm-modal adm-modal--wide">
            <div className="adm-modal__header">
              <div className="adm-modal__icon adm-modal__icon--green">
                <i className="bi bi-plus-circle-fill" />
              </div>
              <span className="adm-modal__title">Create Config Entries</span>
              <button className="adm-modal__close" onClick={() => { setCreateModalOpen(false); setCreateSubmitAttempted(false); }} aria-label="Close">
                <i className="bi bi-x-lg" />
              </button>
            </div>
            <div className="adm-modal__body adm-create-modal-body">
              <div className="adm-create-rows">
                {createRows.map((row, i) => {
                  const keyMissing = createSubmitAttempted && !row.key.trim();
                  const valMissing = createSubmitAttempted && row.tab !== 'boolean' && !row.value.trim();
                  return (
                    <div key={i} className="adm-create-row">
                      <div className="adm-create-row__num">{i + 1}</div>
                      <select
                        className="adm-input adm-select adm-create-row__tab"
                        value={row.tab}
                        onChange={e => {
                          const newTab = e.target.value as ConfigTab;
                          const defaultValue = newTab === 'boolean' ? 'false' : newTab === 'numeric' ? '0' : '';
                          setCreateRows(rows => rows.map((r, j) => j === i ? { ...r, tab: newTab, key: '', value: defaultValue } : r));
                        }}
                      >
                        {(Object.keys(TAB_DISPLAY) as ConfigTab[]).map(t => <option key={t} value={t}>{TAB_DISPLAY[t].label}</option>)}
                      </select>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                        <input
                          className={`adm-input adm-create-row__key${keyMissing ? ' is-invalid' : ''}`}
                          placeholder="enter key name"
                          value={row.key}
                          onChange={e => setCreateRows(rows => rows.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                        />
                        {keyMissing && <span style={{ fontSize: '0.68rem', color: '#dc3545' }}><i className="bi bi-exclamation-circle" /> Key is required</span>}
                      </div>
                      {row.tab === 'boolean' ? (
                        <div className="adm-create-row__value adm-create-row__value--toggle">
                          <span className={`adm-toggle-label${row.value === 'true' ? ' adm-toggle-label--on' : ''}`}>
                            {row.value === 'true' ? 'true' : 'false'}
                          </span>
                          <button
                            type="button"
                            className={`adm-toggle-btn${row.value === 'true' ? ' adm-toggle-btn--on' : ' adm-toggle-btn--off'}`}
                            onClick={() => setCreateRows(rows => rows.map((r, j) => j === i ? { ...r, value: r.value === 'true' ? 'false' : 'true' } : r))}
                            aria-pressed={row.value === 'true'}
                          >
                            <span className="adm-toggle-btn__knob" />
                          </button>
                        </div>
                      ) : row.tab === 'numeric' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                          <input
                            className={`adm-input adm-create-row__value${valMissing ? ' is-invalid' : ''}`}
                            type="number"
                            placeholder="0"
                            value={row.value}
                            onChange={e => setCreateRows(rows => rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                          />
                          {valMissing && <span style={{ fontSize: '0.68rem', color: '#dc3545' }}><i className="bi bi-exclamation-circle" /> Value is required</span>}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                          <textarea
                            className={`adm-input adm-create-row__value${valMissing ? ' is-invalid' : ''}`}
                            placeholder={row.tab === 'array' ? '["value1","value2"]' : row.tab === 'json' ? '{"key":"value"}' : 'plain string'}
                            rows={2}
                            value={row.value}
                            onChange={e => setCreateRows(rows => rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                          />
                          {valMissing && <span style={{ fontSize: '0.68rem', color: '#dc3545' }}><i className="bi bi-exclamation-circle" /> Value is required</span>}
                        </div>
                      )}
                      <button
                          type="button"
                          className="adm-tag__remove adm-create-row__remove"
                          onClick={() => setCreateRows(rows => rows.filter((_, j) => j !== i))}
                          aria-label="Remove row"
                          disabled={createRows.length === 1}
                          title={createRows.length === 1 ? 'Cannot remove the only row' : 'Remove row'}
                        >
                          <i className="bi bi-x" />
                        </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="adm-add-row-btn"
                onClick={() => setCreateRows(rows => [...rows, { tab: 'boolean', key: '', value: 'false' }])}
              >
                <i className="bi bi-plus" /> Add Row
              </button>
            </div>
            <div className="adm-modal__footer">
              <button className="adm-btn adm-btn--ghost" onClick={() => { setCreateModalOpen(false); setCreateSubmitAttempted(false); }}>Cancel</button>
              <button
                className="adm-btn adm-btn--primary"
                onClick={() => void handleConfigCreate()}
                disabled={createStatus === 'loading'}
              >
                {createStatus === 'loading'
                  ? <><div className="spinner-border spinner-border-sm" role="status" /> Creating…</>
                  : <><i className="bi bi-plus-circle-fill" /> Create</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ RELOAD PREVIEW MODAL ══════════════════════════════════════════════ */}
      {reloadPreviewOpen && (
        <div className="adm-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setReloadPreviewOpen(false); }}>
          <div className="adm-modal adm-modal--wide">
            <div className="adm-modal__header">
              <div className="adm-modal__icon adm-modal__icon--blue">
                <i className="bi bi-arrow-clockwise" />
              </div>
              <span className="adm-modal__title">Effective Config Preview</span>
              <button className="adm-modal__close" onClick={() => setReloadPreviewOpen(false)} aria-label="Close">
                <i className="bi bi-x-lg" />
              </button>
            </div>
            <div className="adm-modal__body adm-reload-preview-body">
              {Object.keys(reloadPreviewData).length === 0 ? (
                <div className="adm-field-desc" style={{ padding: '1.5rem', textAlign: 'center' }}>
                  <i className="bi bi-check-circle" style={{ fontSize: '1.5rem', marginBottom: '0.5rem', display: 'block', color: 'var(--adm-success)' }} />
                  No effective Config Preview available.
                </div>
              ) : (
                <>
                  <p className="adm-reload-preview-hint">
                    <i className="bi bi-info-circle" />{' '}
                    The following {Object.keys(reloadPreviewData).length} pending change(s) will be applied on reload.
                  </p>
                  <div className="adm-reload-preview-table">
                    <div className="adm-reload-preview-row adm-reload-preview-row--header">
                      <span className="adm-reload-preview-row__key">Key</span>
                      <span className="adm-reload-preview-row__from">Current</span>
                      <span className="adm-reload-preview-row__to">New Value</span>
                    </div>
                    {Object.entries(reloadPreviewData).map(([key, { from, to }]) => (
                      <div key={key} className="adm-reload-preview-row">
                        <span className="adm-reload-preview-row__key">{key}</span>
                        <span className="adm-reload-preview-row__from adm-reload-preview-row__from--old">{from === null ? 'null' : from}</span>
                        <span className="adm-reload-preview-row__to adm-reload-preview-row__to--new">{to === null ? 'null' : to}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <div className="adm-modal__footer">
              <button className="adm-btn adm-btn--ghost" onClick={() => setReloadPreviewOpen(false)}>Cancel</button>
              {Object.keys(reloadPreviewData).length > 0 && (
                <button
                  className="adm-btn adm-btn--primary"
                  onClick={() => void handleConfirmReload()}
                  disabled={reloadConfirmStatus === 'loading'}
                >
                  {reloadConfirmStatus === 'loading'
                    ? <><div className="spinner-border spinner-border-sm" role="status" /> Reloading…</>
                    : <><i className="bi bi-arrow-clockwise" /> Reload Config</>}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
