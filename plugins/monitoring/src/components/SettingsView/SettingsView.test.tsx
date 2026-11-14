import { fireEvent, screen } from '@testing-library/react';
import {
  MockConfigApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import {
  configApiRef,
  discoveryApiRef,
  FetchApi,
  fetchApiRef,
} from '@backstage/core-plugin-api';
import { SettingsView } from './SettingsView';
import { SettingsContext, SettingsState } from '../../services/settings';

const render = async (state: SettingsState, fetch = jest.fn()) => {
  const setState = jest.fn();
  const config = new MockConfigApi({
    monitoring: { costs: { currency: 'ZMW' } },
  });
  await renderInTestApp(
    <TestApiProvider
      apis={[
        [configApiRef, config],
        [
          discoveryApiRef,
          { getBaseUrl: async () => 'http://b/api/monitoring' },
        ],
        [fetchApiRef, { fetch } as unknown as FetchApi],
      ]}
    >
      <SettingsContext.Provider value={{ state, config, setState }}>
        <SettingsView />
      </SettingsContext.Provider>
    </TestApiProvider>,
  );
  return { setState, fetch };
};

describe('SettingsView', () => {
  it('saves a changed tariff for an admin', async () => {
    const fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        settings: {
          'costs.electricity.tariffPerKwh': {
            value: 2.94,
            updatedBy: 'user:default/a',
            updatedAt: '2026-11-14T00:00:00Z',
          },
        },
        canEdit: true,
      }),
    }));
    const { setState } = await render(
      { available: true, settings: {}, canEdit: true },
      fetch,
    );
    fireEvent.change(screen.getByLabelText('Price of a kWh'), {
      target: { value: '2.94' },
    });
    fireEvent.click(screen.getByText('Save (1)'));
    expect(await screen.findByText(/Saved 1 setting/)).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[0] as any[];
    expect(url).toBe('http://b/api/monitoring/settings');
    expect(JSON.parse(init.body)).toEqual({
      changes: { 'costs.electricity.tariffPerKwh': 2.94 },
    });
    expect(setState).toHaveBeenCalled();
  });

  it('is read-only without the permission', async () => {
    await render({ available: true, settings: {}, canEdit: false });
    expect(screen.getByText(/monitoring.settings.update/)).toBeInTheDocument();
    expect(screen.getByLabelText('Price of a kWh')).toBeDisabled();
    expect(screen.queryByText(/^Save/)).not.toBeInTheDocument();
  });

  it('explains when the backend is missing', async () => {
    await render({
      available: false,
      settings: {},
      canEdit: false,
      error: 'HTTP 404',
    });
    expect(screen.getByText(/plugin-monitoring-backend/)).toBeInTheDocument();
  });
});
