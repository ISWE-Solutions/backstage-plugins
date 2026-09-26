import { backstageSearchLink, proxmoxGuestLink } from './links';

const urls = {
  pve11: 'https://10.20.30.14:8006',
  pve13: 'https://10.20.30.22:8006/',
};

describe('address links', () => {
  it('links LXC and VM guests to the Proxmox UI of their node', () => {
    expect(proxmoxGuestLink({ description: 'LXC 115 on pve11' }, urls)).toBe(
      'https://10.20.30.14:8006/#v1:0:=lxc%2F115:4:::::::',
    );
    expect(
      proxmoxGuestLink({ description: 'VM 223 on pve13 (stopped)' }, urls),
    ).toBe('https://10.20.30.22:8006/#v1:0:=qemu%2F223:4:::::::');
  });

  it('has no link for non-guests or unknown nodes', () => {
    expect(
      proxmoxGuestLink({ description: 'active DHCP lease' }, urls),
    ).toBeUndefined();
    expect(
      proxmoxGuestLink({ description: 'LXC 1 on pve99' }, urls),
    ).toBeUndefined();
  });

  it('searches Backstage by hostname, falling back to the IP', () => {
    expect(
      backstageSearchLink({ hostname: 'keycloak', ipAddress: '10.20.30.126' }),
    ).toBe('/search?query=keycloak');
    expect(backstageSearchLink({ hostname: '', ipAddress: '10.20.30.2' })).toBe(
      '/search?query=10.20.30.2',
    );
  });
});
