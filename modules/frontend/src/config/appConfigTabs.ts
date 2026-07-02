import type { ConfigEntry } from '../services/configService';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConfigTab = 'boolean' | 'numeric' | 'string' | 'array' | 'json';

// ─── Tab display metadata ─────────────────────────────────────────────────────

export const TAB_DISPLAY: Record<ConfigTab, { label: string; icon: string }> = {
  boolean: { label: 'Boolean', icon: 'bi-toggle-on' },
  numeric: { label: 'Numeric', icon: 'bi-123' },
  string:  { label: 'String',  icon: 'bi-type' },
  array:   { label: 'Array',   icon: 'bi-list-ul' },
  json:    { label: 'JSON',    icon: 'bi-braces' },
};

// ─── Compound API entry handlers ──────────────────────────────────────────────
//
// These describe HOW the API packages data, not which keys belong to which tab.
// Each compound key is expanded into flat sub-keys and can be re-packed for saving.

interface CompoundHandler {
  expand: (raw: string) => Record<string, string>;
  pack: (flat: Record<string, string>, original: string) => string;
}

export const COMPOUND_HANDLERS: Record<string, CompoundHandler> = {
  api: {
    expand: (raw) => {
      try {
        const parsed = JSON.parse(raw) as { limits?: Record<string, unknown> };
        return Object.fromEntries(
          Object.entries(parsed.limits ?? {}).map(([k, v]) => [k, String(v)]),
        );
      } catch { return {}; }
    },
    pack: (flat, original) => {
      try {
        const template = JSON.parse(original) as { limits?: Record<string, unknown> };
        const limits = { ...(template.limits ?? {}) };
        for (const k of Object.keys(limits)) {
          if (k in flat) limits[k] = parseFloat(flat[k]) || parseInt(flat[k]) || 0;
        }
        return JSON.stringify({ ...template, limits });
      } catch { return original; }
    },
  },
  queue: {
    expand: (raw) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [`queue.${k}`, String(v)]),
        );
      } catch { return {}; }
    },
    pack: (flat, original) => {
      try {
        const template = JSON.parse(original) as Record<string, unknown>;
        const updated = { ...template };
        for (const [fk, fv] of Object.entries(flat)) {
          if (fk.startsWith('queue.')) {
            const k = fk.slice('queue.'.length);
            updated[k] = typeof template[k] === 'number' ? (parseInt(fv) || 0) : fv;
          }
        }
        return JSON.stringify(updated);
      } catch { return original; }
    },
  },
};

// ─── Key classification — purely by value type ───────────────────────────────

function classifyFlatKey(flatValue: string): ConfigTab {
  if (flatValue === 'true' || flatValue === 'false') return 'boolean';
  const trimmed = flatValue.trim();
  if (trimmed !== '' && !isNaN(Number(trimmed))) return 'numeric';
  try {
    const parsed: unknown = JSON.parse(flatValue);
    if (typeof parsed === 'object' && parsed !== null) {
      return Array.isArray(parsed) ? 'array' : 'json';
    }
  } catch { /* not JSON */ }
  return 'string';
}

// ─── Expanded config ──────────────────────────────────────────────────────────

export interface ExpandedConfig {
  flat: Record<string, string>;
  reverseMap: Record<string, string>;  // flat key → original API key
  originalEntries: ConfigEntry[];
}

export function expandApiEntries(entries: ConfigEntry[]): ExpandedConfig {
  const flat: Record<string, string> = {};
  const reverseMap: Record<string, string> = {};

  for (const { key, value } of entries) {
    const handler = COMPOUND_HANDLERS[key];
    if (handler) {
      for (const [fk, fv] of Object.entries(handler.expand(value))) {
        flat[fk] = fv;
        reverseMap[fk] = key;
      }
    } else {
      flat[key] = value;
      reverseMap[key] = key;
    }
  }

  return { flat, reverseMap, originalEntries: entries };
}

// ─── Tab derivation ───────────────────────────────────────────────────────────

export function deriveTabsFromFlat(
  flat: Record<string, string>,
  reverseMap: Record<string, string>,
  tabOverrides: Record<string, ConfigTab> = {},
): { tabs: Array<{ id: ConfigTab; label: string; icon: string }>; tabKeyMap: Record<string, string[]> } {
  const groups: Partial<Record<ConfigTab, string[]>> = {};

  for (const flatKey of Object.keys(flat)) {
    const tabId = tabOverrides[flatKey] ?? classifyFlatKey(flat[flatKey]);
    (groups[tabId] ??= []).push(flatKey);
  }

  const tabs = (Object.keys(TAB_DISPLAY) as ConfigTab[])
    .filter((id) => id in groups)
    .map((id) => ({ id, ...TAB_DISPLAY[id] }));

  return { tabs, tabKeyMap: groups as Record<string, string[]> };
}

// ─── Flat key → API key ───────────────────────────────────────────────────────

export function flatKeyToApiKey(flatKey: string, reverseMap: Record<string, string>): string {
  return reverseMap[flatKey] ?? flatKey;
}

// ─── Build savable entries from the set of dirty API keys ────────────────────

export function buildSavableEntries(
  changedApiKeys: string[],
  flat: Record<string, string>,
  expandedConfig: ExpandedConfig,
): ConfigEntry[] {
  return changedApiKeys.map((apiKey) => {
    const handler = COMPOUND_HANDLERS[apiKey];
    const origEntry = expandedConfig.originalEntries.find((e) => e.key === apiKey) ?? { key: apiKey, value: '{}' };
    if (handler) return { key: apiKey, value: handler.pack(flat, origEntry.value) };
    return { key: apiKey, value: flat[apiKey] ?? '' };
  });
}
