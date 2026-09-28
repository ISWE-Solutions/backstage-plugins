import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { ProxmoxPage } from './ProxmoxPage';
import { proxmoxApiRef } from '../../services/proxmoxService';
import { ProxmoxResources } from '@internal/plugin-proxmox-common';

const resources: ProxmoxResources = {
  cluster: { name: 'DC1', quorate: true, nodesOnline: 1, nodesTotal: 1 },
  nodes: [
    {
      node: 'pve10',
      status: 'online',
      cpu: 0.1,
      maxcpu: 8,
      mem: 8e9,
      maxmem: 16e9,
      uptime: 100000,
    },
  ],
  guests: [
    {
      id: 'lxc/190',
      vmid: 190,
      type: 'lxc',
      name: 'ento',
      node: 'pve10',
      status: 'running',
      cpu: 0.05,
      maxcpu: 2,
      mem: 1e9,
      maxmem: 2e9,
      disk: 0,
      maxdisk: 0,
      uptime: 500,
      netin: 0,
      netout: 0,
      diskread: 0,
      diskwrite: 0,
      template: false,
      tags: ['prod'],
    },
  ],
  storage: [
    {
      id: 's1',
      storage: 'uc3200',
      node: 'pve10',
      type: 'dir',
      content: 'images',
      used: 5e9,
      total: 1e10,
      avail: 5e9,
      usage: 0.5,
      shared: true,
      enabled: true,
      active: true,
    },
  ],
  generatedAt: new Date().toISOString(),
};

const api = {
  getClusters: jest.fn(async () => ({
    clusters: [
      {
        id: 'config:dc1',
        name: 'DC1',
        url: 'https://x',
        verifyTls: false,
        source: 'config',
        hasToken: true,
        uiUrls: {},
      },
    ],
  })),
  getResources: jest.fn(async () => resources),
  getAttention: jest.fn(async () => ({
    items: [
      {
        category: 'storageFull',
        severity: 'high',
        subject: 'uc3200',
        node: 'pve10',
        detail: '95% used on pve10',
      },
    ],
    generatedAt: resources.generatedAt,
  })),
};

const render = () =>
  renderInTestApp(
    <TestApiProvider apis={[[proxmoxApiRef, api as any]]}>
      <ProxmoxPage />
    </TestApiProvider>,
  );

describe('ProxmoxPage', () => {
  it('shows the cluster overview and nodes', async () => {
    await render();
    expect(await screen.findByText('pve10')).toBeTruthy();
    // nodes online stat
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getAllByText(/DC1/).length).toBeGreaterThan(0);
  });

  it('switches to the Guests tab and lists a guest', async () => {
    await render();
    await screen.findByText('pve10');
    fireEvent.click(screen.getByText(/Guests \(1\)/));
    expect(await screen.findByText('ento')).toBeTruthy();
    expect(screen.getByText('prod')).toBeTruthy();
  });

  it('expands a guest row to reveal details', async () => {
    await render();
    await screen.findByText('pve10');
    fireEvent.click(screen.getByText(/Guests \(1\)/));
    fireEvent.click(await screen.findByText('ento'));
    // detail fields appear only once expanded
    expect(await screen.findByText('Net in')).toBeTruthy();
    expect(screen.getByText('LXC container')).toBeTruthy();
  });

  it('shows attention items', async () => {
    await render();
    await screen.findByText('pve10');
    fireEvent.click(screen.getByText('Attention'));
    await waitFor(() =>
      expect(screen.getByText('95% used on pve10')).toBeTruthy(),
    );
  });
});
