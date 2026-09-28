import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Tab, Tabs, Typography } from '@material-ui/core';
import RefreshIcon from '@material-ui/icons/Refresh';
import {
  Content,
  ContentHeader,
  Header,
  Page,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import {
  AttentionItem,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { proxmoxApiRef } from '../../services/proxmoxService';
import { OverviewTab } from './OverviewTab';
import { GuestsTab } from './GuestsTab';
import { StorageTab } from './StorageTab';
import { AttentionTab } from './AttentionTab';

const REFRESH_MS = 30_000;

export const ProxmoxPage = () => {
  const api = useApi(proxmoxApiRef);
  const [tab, setTab] = useState(0);
  const [data, setData] = useState<ProxmoxResources>();
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [res, att] = await Promise.all([
        api.getResources(),
        api.getAttention(),
      ]);
      setData(res);
      setAttention(att.items);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Page themeId="tool">
      <Header title="Proxmox" subtitle="Cluster monitoring (read-only)" />
      <Content>
        <ContentHeader title="Virtualisation cluster">
          <Box display="flex" alignItems="center" style={{ gap: 12 }}>
            {data && (
              <Typography variant="caption" color="textSecondary">
                updated {new Date(data.generatedAt).toLocaleTimeString()}
              </Typography>
            )}
            <Button
              size="small"
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={load}
            >
              Refresh
            </Button>
          </Box>
        </ContentHeader>

        {error && <ResponseErrorPanel error={error} />}
        {loading && !data && <Progress />}

        {data && (
          <>
            <Tabs
              value={tab}
              onChange={(_e, v) => setTab(v)}
              indicatorColor="primary"
              textColor="primary"
            >
              <Tab label="Overview" />
              <Tab label={`Guests (${data.guests.length})`} />
              <Tab label={`Storage (${data.storage.length})`} />
              <Tab
                label={
                  <Badge color="error" badgeContent={attention.length} max={99}>
                    <span style={{ paddingRight: attention.length ? 12 : 0 }}>
                      Attention
                    </span>
                  </Badge>
                }
              />
            </Tabs>
            <Box mt={2}>
              {tab === 0 && <OverviewTab data={data} />}
              {tab === 1 && <GuestsTab data={data} />}
              {tab === 2 && <StorageTab data={data} />}
              {tab === 3 && <AttentionTab items={attention} />}
            </Box>
          </>
        )}
      </Content>
    </Page>
  );
};
