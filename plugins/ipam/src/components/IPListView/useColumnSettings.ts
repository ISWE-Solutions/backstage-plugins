import { useCallback, useState } from 'react';

export interface ColumnDefinition {
  id: string;
  label: string;
  /** Width in pixels when the user has not resized the column */
  defaultWidth: number;
  /** Shown unless the user hides it */
  defaultVisible?: boolean;
}

interface StoredSettings {
  hidden: string[];
  widths: Record<string, number>;
}

export const MIN_COLUMN_WIDTH = 60;

/** Stored settings, or null when there are none or they cannot be read */
const readStored = (key: string): StoredSettings | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      widths:
        parsed.widths && typeof parsed.widths === 'object' ? parsed.widths : {},
    };
  } catch {
    // storage unavailable or corrupt: fall back to defaults
    return null;
  }
};

const writeStored = (key: string, settings: StoredSettings) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(settings));
  } catch {
    // storage unavailable (private window, blocked site data): keep in memory only
  }
};

/**
 * Per-browser column visibility and widths for a table, remembered in
 * localStorage under `storageKey`. At least one column always stays visible.
 */
export const useColumnSettings = (
  storageKey: string,
  columns: ColumnDefinition[],
) => {
  const [settings, setSettings] = useState<StoredSettings>(() => {
    const stored = readStored(storageKey);
    if (!stored) {
      return {
        hidden: columns.filter(c => c.defaultVisible === false).map(c => c.id),
        widths: {},
      };
    }
    const known = new Set(columns.map(c => c.id));
    return {
      hidden: stored.hidden.filter(id => known.has(id)),
      widths: stored.widths,
    };
  });

  const update = useCallback(
    (next: (prev: StoredSettings) => StoredSettings) => {
      setSettings(prev => {
        const value = next(prev);
        writeStored(storageKey, value);
        return value;
      });
    },
    [storageKey],
  );

  const isVisible = (id: string) => !settings.hidden.includes(id);

  const visibleColumns = columns.filter(c => isVisible(c.id));

  const toggleColumn = (id: string) =>
    update(prev => {
      if (prev.hidden.includes(id)) {
        return { ...prev, hidden: prev.hidden.filter(h => h !== id) };
      }
      const stillVisible = columns.filter(
        c => c.id !== id && !prev.hidden.includes(c.id),
      );
      if (stillVisible.length === 0) return prev; // keep at least one column
      return { ...prev, hidden: [...prev.hidden, id] };
    });

  const widthOf = (id: string) =>
    settings.widths[id] ??
    columns.find(c => c.id === id)?.defaultWidth ??
    MIN_COLUMN_WIDTH;

  const setWidth = (id: string, width: number) =>
    update(prev => ({
      ...prev,
      widths: {
        ...prev.widths,
        [id]: Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
      },
    }));

  const resetWidth = (id: string) =>
    update(prev => {
      const { [id]: _removed, ...widths } = prev.widths;
      return { ...prev, widths };
    });

  const resetAll = () =>
    update(() => ({
      hidden: columns.filter(c => c.defaultVisible === false).map(c => c.id),
      widths: {},
    }));

  return {
    visibleColumns,
    isVisible,
    toggleColumn,
    widthOf,
    setWidth,
    resetWidth,
    resetAll,
  };
};
