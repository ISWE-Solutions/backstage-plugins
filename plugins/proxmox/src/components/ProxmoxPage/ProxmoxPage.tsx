import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  MenuItem,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@material-ui/core';
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
  ProxmoxCluster,
  ProxmoxResources,
} from '@internal/plugin-proxmox-common';
import { proxmoxApiRef } from '../../services/proxmoxService';
import { OverviewTab } from './OverviewTab';
import { GuestsTab } from './GuestsTab';
import { StorageTab } from './StorageTab';
import { AttentionTab } from './AttentionTab';
import { SettingsTab } from './SettingsTab';

const REFRESH_MS = 30_000;

export const ProxmoxPage = () => {
  const api = useApi(proxmoxApiRef);
  const [tab, setTab] = useState(0);
  const [clusters, setClusters] = useState<ProxmoxCluster[]>([]);
  const [clusterId, setClusterId] = useState<string>('');
  const [data, setData] = useState<ProxmoxResources>();
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const loadClusters = useCallback(async () => {
    try {
      const { clusters: list } = await api.getClusters();
      setClusters(list);
      setClusterId(prev =>
        prev && list.some(c => c.id === prev) ? prev : list[0]?.id ?? '',
      );
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setLoading(false);
    }
  }, [api]);

  const load = useCallback(async () => {
    if (!clusterId) {
      setLoading(false);
      return;
    }
    try {
      const [res, att] = await Promise.all([
        api.getResources(clusterId),
        api.getAttention(clusterId),
      ]);
      setData(res);
      setAttention(att.items);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [api, clusterId]);

  useEffect(() => {
    loadClusters();
  }, [loadClusters]);

  useEffect(() => {
    if (!clusterId) return undefined;
    setData(undefined);
    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load, clusterId]);

  const noClusters = clusters.length === 0;

  return (
    <Page themeId="tool">
      <Header title="Proxmox" subtitle="Cluster monitoring (read-only)" />
      <Content>
        <ContentHeader title="Virtualisation clusters">
          <Box display="flex" alignItems="center" style={{ gap: 12 }}>
            {clusters.length > 0 && (
              <TextField
                select
                size="small"
                variant="outlined"
                label="Cluster"
                value={clusterId}
                onChange={e => setClusterId(e.target.value)}
                style={{ minWidth: 180 }}
              >
                {clusters.map(c => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
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
        {loading && !data && !noClusters && <Progress />}

        <Tabs
          value={tab}
          onChange={(_e, v) => setTab(v)}
          indicatorColor="primary"
          textColor="primary"
        >
          <Tab label="Overview" />
          <Tab label={data ? `Guests (${data.guests.length})` : 'Guests'} />
          <Tab label={data ? `Storage (${data.storage.length})` : 'Storage'} />
          <Tab
            label={
              <Box
                component="span"
                display="inline-flex"
                alignItems="center"
                style={{ gap: 6 }}
              >
                Attention
                {attention.length > 0 && (
                  <Chip
                    size="small"
                    label={attention.length > 99 ? '99+' : attention.length}
                    style={{
                      height: 18,
                      backgroundColor: '#c62828',
                      color: '#fff',
                    }}
                  />
                )}
              </Box>
            }
          />
          <Tab label="Settings" />
        </Tabs>

        <Box mt={2}>
          {tab === 4 ? (
            <SettingsTab clusters={clusters} onChanged={loadClusters} />
          ) : noClusters ? (
            <Typography color="textSecondary">
              No clusters configured yet. Add one on the Settings tab.
            </Typography>
          ) : (
            data && (
              <>
                {tab === 0 && <OverviewTab data={data} />}
                {tab === 1 && <GuestsTab data={data} />}
                {tab === 2 && <StorageTab data={data} />}
                {tab === 3 && <AttentionTab items={attention} />}
              </>
            )
          )}
        </Box>
      </Content>
    </Page>
  );
};
