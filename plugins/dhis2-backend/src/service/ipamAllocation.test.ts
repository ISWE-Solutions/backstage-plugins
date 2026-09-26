import { ProvisionService } from './provisionService';
import { IpAllocator } from './ipamAllocator';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn(),
} as any;
const newJob = () =>
  ({
    id: 'j1',
    status: 'running',
    lines: [] as string[],
    output: [] as string[],
  } as any);
const text = (job: any) => JSON.stringify(job);

const allocation = {
  id: '42',
  ip: '10.20.30.150',
  prefix: 24,
  gateway: '10.20.30.1',
};
const fakeAllocator = (): jest.Mocked<IpAllocator> => ({
  allocate: jest.fn().mockResolvedValue(allocation),
  confirm: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
});

// allocateIp / settleIp are private; exercise them directly
const svc = (allocator?: IpAllocator) =>
  new ProvisionService(logger, null, {} as any, allocator) as any;

describe('ProvisionService IPAM allocation', () => {
  it('uses DHCP (no allocation) when IPAM is not configured', async () => {
    expect(await svc().allocateIp(newJob(), 'h', 'p')).toBeUndefined();
  });

  it('allocates with the requester and logs the address', async () => {
    const allocator = fakeAllocator();
    const job = newJob();
    const got = await svc(allocator).allocateIp(
      job,
      'hmis-test',
      'DHIS2 instance hmis-test',
      'user:default/tester',
    );
    expect(got).toEqual(allocation);
    expect(allocator.allocate).toHaveBeenCalledWith({
      hostname: 'hmis-test',
      purpose: 'DHIS2 instance hmis-test',
      requestedBy: 'user:default/tester',
    });
    expect(text(job)).toContain('IPAM allocated 10.20.30.150/24');
  });

  it('propagates allocation failure so the job does not fall back to DHCP', async () => {
    const allocator = fakeAllocator();
    allocator.allocate.mockRejectedValue(new Error('No free address'));
    await expect(svc(allocator).allocateIp(newJob(), 'h', 'p')).rejects.toThrow(
      'No free address',
    );
  });

  it('confirms on success and releases on failure', async () => {
    const allocator = fakeAllocator();
    const s = svc(allocator);
    await s.settleIp(
      newJob(),
      allocation,
      true,
      'DHIS2 x: LXC 190 on pve12',
      'hmis-test',
    );
    expect(allocator.confirm).toHaveBeenCalledWith('42', {
      hostname: 'hmis-test',
      description: 'DHIS2 x: LXC 190 on pve12',
    });
    await s.settleIp(newJob(), allocation, false, 'd', 'hmis-test');
    expect(allocator.release).toHaveBeenCalledWith('42');
  });

  it('never fails the job when confirming fails, but says how to fix it', async () => {
    const allocator = fakeAllocator();
    allocator.confirm.mockRejectedValue(new Error('phpIPAM down'));
    const job = newJob();
    await expect(
      svc(allocator).settleIp(job, allocation, true, 'd', 'h'),
    ).resolves.toBeUndefined();
    expect(text(job)).toContain(
      'could not confirm IPAM allocation 10.20.30.150',
    );
  });
});
