import {
  Content,
  ContentHeader,
  Header,
  Page,
  SupportButton,
} from '@backstage/core-components';
import { Button } from '@material-ui/core';
import ArrowBackIcon from '@material-ui/icons/ArrowBack';
import { Link as RouterLink } from 'react-router-dom';
import { ProxmoxSettingsPanel } from './ProxmoxSettingsPanel';

/**
 * Settings page for the DHIS2 plugin. Holds the Proxmox connection settings used
 * by provisioning (create/clone/update). Cluster monitoring is a separate,
 * read-only tool at /proxmox.
 */
export const DHIS2SettingsPage = () => (
  <Page themeId="tool">
    <Header title="DHIS2 Settings" subtitle="Provisioning configuration" />
    <Content>
      <ContentHeader title="Proxmox connection">
        <Button
          component={RouterLink}
          to="/dhis2"
          startIcon={<ArrowBackIcon />}
          size="small"
        >
          Back to DHIS2
        </Button>
        <SupportButton>
          These settings configure how the DHIS2 orchestrator reaches Proxmox.
        </SupportButton>
      </ContentHeader>
      <ProxmoxSettingsPanel />
    </Content>
  </Page>
);
