import React, { useState } from 'react';
import { Box, Tabs, Tab, Paper } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { DashboardView } from '../DashboardView/DashboardView';
import { IPListView } from '../IPListView/IPListView';
import { SubnetListView } from '../SubnetListView/SubnetListView';
import { AttentionView } from '../AttentionView/AttentionView';
import { SubnetMapView } from '../SubnetMap/SubnetMapView';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(3),
  },
  tabsContainer: {
    marginBottom: theme.spacing(3),
  },
}));

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

const TabPanel = (props: TabPanelProps) => {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`ipam-tabpanel-${index}`}
      aria-labelledby={`ipam-tab-${index}`}
      {...other}
    >
      {value === index && <Box>{children}</Box>}
    </div>
  );
};

const TABS = ['dashboard', 'addresses', 'subnets', 'map', 'attention'];

export const IPAMPage = () => {
  const classes = useStyles();
  // ?tab=attention (used by IPAM notifications) opens a tab directly
  const [activeTab, setActiveTab] = useState(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    const index = TABS.indexOf((tab ?? '').toLowerCase());
    return index >= 0 ? index : 0;
  });

  const handleTabChange = (_event: React.ChangeEvent<{}>, newValue: number) => {
    setActiveTab(newValue);
  };

  return (
    <Box className={classes.root}>
      <Paper className={classes.tabsContainer}>
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          indicatorColor="primary"
          textColor="primary"
        >
          <Tab label="Dashboard" />
          <Tab label="IP Addresses" />
          <Tab label="Subnets" />
          <Tab label="Map" />
          <Tab label="Attention" />
        </Tabs>
      </Paper>

      <TabPanel value={activeTab} index={0}>
        <DashboardView />
      </TabPanel>

      <TabPanel value={activeTab} index={1}>
        <IPListView />
      </TabPanel>

      <TabPanel value={activeTab} index={2}>
        <SubnetListView />
      </TabPanel>

      <TabPanel value={activeTab} index={3}>
        <SubnetMapView />
      </TabPanel>

      <TabPanel value={activeTab} index={4}>
        <AttentionView />
      </TabPanel>
    </Box>
  );
};
