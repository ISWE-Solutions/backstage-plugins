import { fetchDisks, fetchSmart } from './disks';

describe('fetchDisks', () => {
  it('maps disks across nodes and derives Ceph usage', async () => {
    const client = {
      get: jest.fn(async (path: string) => {
        if (path === 'nodes/pve10/disks/list') {
          return {
            status: 200,
            body: {
              data: [
                {
                  devpath: '/dev/sda',
                  model: 'Samsung SSD',
                  serial: 'S1',
                  size: 512e9,
                  type: 'ssd',
                  health: 'PASSED',
                  wearout: 3,
                  used: 'LVM',
                },
                {
                  devpath: '/dev/sdb',
                  size: 4e12,
                  type: 'hdd',
                  health: 'PASSED',
                  wearout: 'N/A',
                  osdid: 5,
                },
              ],
            },
          };
        }
        return { status: 200, body: { data: [] } };
      }),
    };
    const disks = await fetchDisks(client, ['pve10', 'pve11']);
    expect(disks).toHaveLength(2);
    const sda = disks.find(d => d.devpath === '/dev/sda')!;
    expect(sda.id).toBe('pve10:/dev/sda');
    expect(sda.wearout).toBe(3);
    expect(sda.used).toBe('LVM');
    const sdb = disks.find(d => d.devpath === '/dev/sdb')!;
    expect(sdb.wearout).toBeUndefined(); // 'N/A' -> undefined
    expect(sdb.used).toBe('Ceph OSD.5');
  });

  it('ignores nodes whose disks/list fails', async () => {
    const client = {
      get: jest.fn(async () => {
        throw new Error('down');
      }),
    };
    expect(await fetchDisks(client, ['pve10'])).toEqual([]);
  });
});

describe('fetchSmart', () => {
  it('parses attributes and extracts temperature and power-on hours', async () => {
    const client = {
      get: jest.fn(async () => ({
        status: 200,
        body: {
          data: {
            health: 'PASSED',
            type: 'ata',
            attributes: [
              {
                id: 194,
                name: 'Temperature_Celsius',
                value: 70,
                worst: 60,
                threshold: 0,
                raw: '34 (Min/Max 20/45)',
              },
              { id: 9, name: 'Power_On_Hours', value: 99, raw: '12345' },
            ],
          },
        },
      })),
    };
    const smart = await fetchSmart(client, 'pve10', '/dev/sda');
    expect(smart.health).toBe('PASSED');
    expect(smart.temperature).toBe(34);
    expect(smart.powerOnHours).toBe(12345);
    expect(smart.attributes).toHaveLength(2);
  });
});
