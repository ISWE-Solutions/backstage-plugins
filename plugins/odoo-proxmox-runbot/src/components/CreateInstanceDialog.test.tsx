import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { CreateInstanceDialog } from './CreateInstanceDialog';
import { PostgresCluster } from '../types';

const clusters: PostgresCluster[] = [
  {
    name: 'prod',
    environment: 'production',
    host: 'pg',
    port: 5432,
    sslmode: 'verify-full',
  },
  {
    name: 'stg',
    environment: 'staging',
    host: 'pg',
    port: 5442,
    sslmode: 'verify-full',
  },
];

const catalogApi = {
  getEntities: jest.fn(async () => ({
    items: [
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'iswe-meal-addons',
          namespace: 'default',
          title: 'MEAL addons',
          annotations: {
            'github.com/project-slug': 'ISWE-Solutions/iswe_meal_addons',
          },
        },
      },
    ],
  })),
};

describe('CreateInstanceDialog', () => {
  it('walks the five steps and blocks creation until the request is valid', async () => {
    const onCreate = jest.fn(async () => {});
    await renderInTestApp(
      <TestApiProvider apis={[[catalogApiRef, catalogApi]]}>
        <CreateInstanceDialog
          open
          onClose={() => {}}
          onCreate={onCreate}
          nodes={[]}
          versions={['19.0', '18.0']}
          clusters={clusters}
        />
      </TestApiProvider>,
    );

    // Basics: defaults to the newest version, on its only OS
    expect(screen.getByText('Python 3.12')).toBeInTheDocument();
    expect(catalogApi.getEntities).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { kind: 'Component', 'metadata.tags': 'odoo' },
      }),
    );

    // Sources: addons_path preview
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText(/\/opt\/odoo\/odoo\/addons/)).toBeInTheDocument();

    // Database: the staging default uses the stg cluster
    fireEvent.click(screen.getByText('Next'));
    expect(
      screen.getByText(/Connects to pg:5442 with sslmode=verify-full/),
    ).toBeInTheDocument();

    // Configuration, then Review: errors listed, Create disabled
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText(/Suggested for 4 cores/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() =>
      expect(screen.getByText('Fix before creating:')).toBeInTheDocument(),
    );
    expect(screen.getByText('Instance name is required')).toBeInTheDocument();
    expect(
      screen.getByText('Create instance').closest('button'),
    ).toBeDisabled();
    expect(screen.getByText(/list_db = False/)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
