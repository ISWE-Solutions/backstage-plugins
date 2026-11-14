import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Box, LinearProgress, Paper, Tab, Tabs } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import {
  configApiRef,
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { PrometheusView } from '../PrometheusView/PrometheusView';
import { GrafanaView } from '../GrafanaView/GrafanaView';
import { SecurityView } from '../SecurityView/SecurityView';
import { CostInsightsView } from '../CostInsightsView/CostInsightsView';
import { SettingsView } from '../SettingsView/SettingsView';
import {
  effectiveConfig,
  loadSettings,
  SettingsContext,
  SettingsState,
} from '../../services/settings';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(3),
  },
  tabsContainer: {
    marginBottom: theme.spacing(3),
  },
}));

const TabPanel = (props: {
  children?: ReactNode;
  index: number;
  value: number;
}) => {
  const { children, value, index } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`monitoring-tabpanel-${index}`}
      aria-labelledby={`monitoring-tab-${index}`}
    >
      {value === index && <Box>{children}</Box>}
    </div>
  );
};

const TABS: { label: string; view: () => JSX.Element | null }[] = [
  { label: 'Prometheus / Health', view: PrometheusView },
  { label: 'Grafana Dashboards', view: GrafanaView },
  { label: 'Security Insights', view: SecurityView },
  { label: 'Cost Insights', view: CostInsightsView },
  { label: 'Settings', view: SettingsView },
];

export const MonitoringPage = () => {
  const classes = useStyles();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const configApi = useApi(configApiRef);
  const [activeTab, setActiveTab] = useState(0);
  const [state, setState] = useState<SettingsState>();

  // the shared settings (Settings tab), loaded once for every tab
  useEffect(() => {
    let cancelled = false;
    loadSettings({ discoveryApi, fetchApi }).then(
      s => !cancelled && setState(s),
    );
    return () => {
      cancelled = true;
    };
  }, [discoveryApi, fetchApi]);

  const value = useMemo(
    () =>
      state
        ? {
            state,
            config: effectiveConfig(configApi, state.settings),
            setState,
          }
        : undefined,
    [state, configApi],
  );

  return (
    <Box className={classes.root}>
      <Paper className={classes.tabsContainer}>
        <Tabs
          value={activeTab}
          onChange={(_e, v) => setActiveTab(v)}
          indicatorColor="primary"
          textColor="primary"
          variant="scrollable"
          scrollButtons="auto"
        >
          {TABS.map(t => (
            <Tab key={t.label} label={t.label} />
          ))}
        </Tabs>
      </Paper>
      {value ? (
        <SettingsContext.Provider value={value}>
          {TABS.map((t, i) => (
            <TabPanel key={t.label} value={activeTab} index={i}>
              <t.view />
            </TabPanel>
          ))}
        </SettingsContext.Provider>
      ) : (
        <LinearProgress />
      )}
    </Box>
  );
};
