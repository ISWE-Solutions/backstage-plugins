import { useState } from 'react';
import { Box, Tab, Tabs } from '@material-ui/core';
import { ProxmoxResources } from '@iswesolutions/plugin-proxmox-common';
import { StoragePoolsTab } from './StoragePoolsTab';
import { DisksTab } from './DisksTab';

/**
 * Storage page with Pulse-style sub-tabs: storage pools and physical disks.
 * Each item expands to an Overview / History detail.
 */
export const StorageTab = ({
  data,
  clusterId,
}: {
  data: ProxmoxResources;
  clusterId: string;
}) => {
  const [sub, setSub] = useState(0);
  return (
    <Box>
      <Tabs
        value={sub}
        onChange={(_e, v) => setSub(v)}
        indicatorColor="primary"
        textColor="primary"
        style={{ marginBottom: 16 }}
      >
        <Tab label="Storage" />
        <Tab label="Physical disks" />
      </Tabs>
      {sub === 0 ? (
        <StoragePoolsTab data={data} />
      ) : (
        <DisksTab clusterId={clusterId} />
      )}
    </Box>
  );
};
