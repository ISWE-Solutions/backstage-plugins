import React, { useState } from 'react';
import { Box, Tabs, Tab, Paper } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { PrometheusView } from '../PrometheusView/PrometheusView';
import { GrafanaView } from '../GrafanaView/GrafanaView';
import { SecurityView } from '../SecurityView/SecurityView';
import { CostInsightsView } from '../CostInsightsView/CostInsightsView';

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
      id={`monitoring-tabpanel-${index}`}
      aria-labelledby={`monitoring-tab-${index}`}
      {...other}
    >
      {value === index && <Box>{children}</Box>}
    </div>
  );
};

export const MonitoringPage = () => {
  const classes = useStyles();
  const [activeTab, setActiveTab] = useState(0);

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
          <Tab label="Prometheus / Health" />
          <Tab label="Grafana Dashboards" />
          <Tab label="Security Insights" />
          <Tab label="Cost Insights" />
        </Tabs>
      </Paper>

      <TabPanel value={activeTab} index={0}>
        <PrometheusView />
      </TabPanel>

      <TabPanel value={activeTab} index={1}>
        <GrafanaView />
      </TabPanel>

      <TabPanel value={activeTab} index={2}>
        <SecurityView />
      </TabPanel>

      <TabPanel value={activeTab} index={3}>
        <CostInsightsView />
      </TabPanel>
    </Box>
  );
};
