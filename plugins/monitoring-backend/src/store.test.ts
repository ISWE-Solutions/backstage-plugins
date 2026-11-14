import { createSettingsStore } from './store';
import { testDatabase } from './__testUtils__/testDatabase';

describe('settings store', () => {
  it('saves, updates and removes settings, with who and when', async () => {
    const store = await createSettingsStore(testDatabase());
    expect(await store.all()).toEqual({});
    await store.apply(
      { 'costs.currency': 'ZMW', 'costs.electricity.tariffPerKwh': 2.5 },
      'user:default/a',
    );
    await store.apply(
      { 'costs.electricity.tariffPerKwh': 3 },
      'user:default/b',
    );
    let all = await store.all();
    expect(all['costs.currency']).toMatchObject({
      value: 'ZMW',
      updatedBy: 'user:default/a',
    });
    expect(all['costs.electricity.tariffPerKwh']).toMatchObject({
      value: 3,
      updatedBy: 'user:default/b',
    });
    expect(Date.parse(all['costs.currency'].updatedAt)).toBeGreaterThan(0);
    await store.apply({ 'costs.currency': null }, 'user:default/a');
    all = await store.all();
    expect(Object.keys(all)).toEqual(['costs.electricity.tariffPerKwh']);
  });
});
