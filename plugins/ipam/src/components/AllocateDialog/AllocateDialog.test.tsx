import { fireEvent, screen } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { AllocateDialog } from './AllocateDialog';
import { ipamApiRef } from '../../services/ipamService';

const api = {
  getAllocationPool: jest.fn(async () => ({
    from: '10.20.30.100',
    to: '10.20.30.199',
    gateway: '10.20.30.1',
    prefix: 24,
  })),
  allocate: jest.fn(),
};

const render = async () =>
  renderInTestApp(
    <TestApiProvider apis={[[ipamApiRef, api]]}>
      <AllocateDialog open onClose={jest.fn()} />
    </TestApiProvider>,
  );

const fill = (hostname: string, purpose: string) => {
  fireEvent.change(screen.getByLabelText(/hostname/i), {
    target: { value: hostname },
  });
  fireEvent.change(screen.getByLabelText(/purpose/i), {
    target: { value: purpose },
  });
};

describe('AllocateDialog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reserves an address and shows how to use it', async () => {
    api.allocate.mockResolvedValue({
      id: '9',
      ip: '10.20.30.150',
      prefix: 24,
      gateway: '10.20.30.1',
    });
    await render();
    expect(
      await screen.findByText(/10\.20\.30\.100–10\.20\.30\.199/),
    ).toBeTruthy();
    fill('reports-uat', 'Reports UAT container');
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));
    expect(
      await screen.findByText(
        'name=eth0,bridge=vmbr0,ip=10.20.30.150/24,gw=10.20.30.1',
      ),
    ).toBeTruthy();
    expect(api.allocate).toHaveBeenCalledWith({
      hostname: 'reports-uat',
      purpose: 'Reports UAT container',
    });
  });

  it('shows the backend error, e.g. an exhausted pool', async () => {
    api.allocate.mockRejectedValue(
      new Error('No free address in 10.20.30.100–10.20.30.199'),
    );
    await render();
    fill('reports-uat', 'Reports UAT container');
    fireEvent.click(screen.getByRole('button', { name: 'Allocate' }));
    expect(await screen.findByText(/No free address/)).toBeTruthy();
  });

  it('keeps Allocate disabled for an invalid hostname', async () => {
    await render();
    fill('bad host!', 'x');
    expect(
      (screen.getByRole('button', { name: 'Allocate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
