import { act, renderHook } from '@testing-library/react';
import {
  ColumnDefinition,
  MIN_COLUMN_WIDTH,
  useColumnSettings,
} from './useColumnSettings';

const KEY = 'test.columns';
const COLUMNS: ColumnDefinition[] = [
  { id: 'ip', label: 'IP', defaultWidth: 140 },
  { id: 'host', label: 'Host', defaultWidth: 180 },
  { id: 'vlan', label: 'VLAN', defaultWidth: 120, defaultVisible: false },
];

const setup = () => renderHook(() => useColumnSettings(KEY, COLUMNS));
const ids = (result: ReturnType<typeof setup>['result']) =>
  result.current.visibleColumns.map(c => c.id);

describe('useColumnSettings', () => {
  beforeEach(() => window.localStorage.clear());

  it('starts with the default visibility and widths', () => {
    const { result } = setup();
    expect(ids(result)).toEqual(['ip', 'host']);
    expect(result.current.widthOf('host')).toBe(180);
  });

  it('hides and shows columns and remembers the choice', () => {
    const { result } = setup();
    act(() => result.current.toggleColumn('host'));
    act(() => result.current.toggleColumn('vlan'));
    expect(ids(result)).toEqual(['ip', 'vlan']);

    const again = setup();
    expect(ids(again.result)).toEqual(['ip', 'vlan']);
  });

  it('never hides the last visible column', () => {
    const { result } = setup();
    act(() => result.current.toggleColumn('host'));
    act(() => result.current.toggleColumn('ip'));
    expect(ids(result)).toEqual(['ip']);
  });

  it('stores widths, enforces the minimum and resets', () => {
    const { result } = setup();
    act(() => result.current.setWidth('ip', 250.6));
    act(() => result.current.setWidth('host', 10));
    expect(result.current.widthOf('ip')).toBe(251);
    expect(result.current.widthOf('host')).toBe(MIN_COLUMN_WIDTH);
    expect(setup().result.current.widthOf('ip')).toBe(251);

    act(() => result.current.resetWidth('ip'));
    expect(result.current.widthOf('ip')).toBe(140);

    act(() => result.current.toggleColumn('vlan'));
    act(() => result.current.resetAll());
    expect(ids(result)).toEqual(['ip', 'host']);
    expect(result.current.widthOf('host')).toBe(180);
  });

  it('ignores corrupt or unknown stored settings', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(ids(setup().result)).toEqual(['ip', 'host']);

    window.localStorage.setItem(
      KEY,
      JSON.stringify({ hidden: ['gone', 'ip'], widths: {} }),
    );
    expect(ids(setup().result)).toEqual(['host', 'vlan']);
  });
});
