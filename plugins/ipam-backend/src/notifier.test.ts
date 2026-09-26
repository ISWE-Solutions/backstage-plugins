import { IPStatus } from '@internal/plugin-ipam-common';
import { IssueStore, notableIssues, runNotifier } from './notifier';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;

const address = (over: Record<string, unknown>) =>
  ({
    id: String(over.ipAddress),
    subnetId: '7',
    status: IPStatus.ALLOCATED,
    source: 'proxmox',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as any);

describe('notableIssues', () => {
  it('includes conflicts, unknown devices, shared MACs and subnet thresholds only', () => {
    const issues = notableIssues(
      [
        address({
          ipAddress: '10.20.30.164',
          source: 'scan',
          macAddress: 'BC:24:11:93:E4:96',
        }),
        address({
          ipAddress: '10.20.30.50',
          notes:
            'discovery: proxmox+arp\nconflict: MAC differs between sources (arp a, proxmox b)',
        }),
        address({
          ipAddress: '10.20.30.23',
          description: 'LXC 113 on pve10 (stopped)',
        }),
        address({ ipAddress: '10.20.30.22', status: IPStatus.OFFLINE }),
      ],
      [
        { id: '7', cidr: '10.20.30.0/24', percent: 91.3 },
        { id: '8', cidr: '192.168.10.0/24', percent: 1 },
      ],
    );
    expect(issues.map(i => [i.key, i.severity])).toEqual([
      ['conflict:10.20.30.50', 'high'],
      ['unknown:10.20.30.164:bc:24:11:93:e4:96', 'normal'],
      ['subnet:7:90', 'high'],
    ]);
  });
});

describe('runNotifier', () => {
  const phpipamWith = (addresses: unknown[], used = 100) => ({
    request: jest.fn(async (_m: string, path: string) => {
      if (path === 'subnets/')
        return {
          status: 200,
          body: {
            data: [
              { id: '7', subnet: '10.20.30.0', mask: '24', isFolder: '0' },
            ],
          },
        };
      if (path === 'subnets/7/usage/')
        return { status: 200, body: { data: { maxhosts: 254, used } } };
      if (path === 'addresses/')
        return { status: 200, body: { data: addresses } };
      return { status: 404, body: {} };
    }),
  });
  const memoryStore = (): IssueStore & { saved: Set<string> } => {
    const saved = new Set<string>();
    return {
      saved,
      keys: async () => [...saved],
      add: async issues => issues.forEach(i => saved.add(i.key)),
      remove: async keys => keys.forEach(k => saved.delete(k)),
    };
  };
  const unknownRaw = {
    id: '1',
    ip: '10.20.30.164',
    subnetId: '7',
    tag: '2',
    mac: 'bc:24:11:93:e4:96',
    note: 'This host was autodiscovered on 2026-09-26',
  };

  it('sends one digest for new issues and stays quiet on the next run', async () => {
    const store = memoryStore();
    const notifications = { send: jest.fn() };
    const deps = {
      phpipam: phpipamWith([unknownRaw]),
      store,
      notifications,
      recipients: ['group:default/phpipam-admins'],
      logger,
    };

    expect(await runNotifier(deps)).toHaveLength(1);
    expect(notifications.send).toHaveBeenCalledWith({
      recipients: {
        type: 'entity',
        entityRef: ['group:default/phpipam-admins'],
      },
      payload: expect.objectContaining({
        title: 'IPAM: 1 new issue',
        link: '/ipam?tab=attention',
        topic: 'ipam',
      }),
    });

    expect(await runNotifier(deps)).toHaveLength(0);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('forgets resolved issues so a recurrence is notified again', async () => {
    const store = memoryStore();
    const notifications = { send: jest.fn() };
    const base = {
      store,
      notifications,
      recipients: ['group:default/phpipam-admins'],
      logger,
    };
    await runNotifier({ ...base, phpipam: phpipamWith([unknownRaw]) });
    await runNotifier({ ...base, phpipam: phpipamWith([]) });
    expect(store.saved.size).toBe(0);
    await runNotifier({ ...base, phpipam: phpipamWith([unknownRaw]) });
    expect(notifications.send).toHaveBeenCalledTimes(2);
  });

  it('does not record issues when sending fails, so they are retried', async () => {
    const store = memoryStore();
    const notifications = {
      send: jest.fn().mockRejectedValue(new Error('down')),
    };
    await expect(
      runNotifier({
        phpipam: phpipamWith([unknownRaw]),
        store,
        notifications,
        recipients: ['x'],
        logger,
      }),
    ).rejects.toThrow('down');
    expect(store.saved.size).toBe(0);
  });
});
