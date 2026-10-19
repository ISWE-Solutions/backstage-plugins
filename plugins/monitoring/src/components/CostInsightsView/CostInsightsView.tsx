import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
} from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { makeStyles } from '@material-ui/core/styles';
import { CostSummary } from '../../types';
import { monitoringService } from '../../services/monitoringService';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Legend,
  Tooltip,
} from 'recharts';
import AttachMoneyIcon from '@material-ui/icons/AttachMoney';
import TrendingUpIcon from '@material-ui/icons/TrendingUp';
import TrendingDownIcon from '@material-ui/icons/TrendingDown';
import TrendingFlatIcon from '@material-ui/icons/TrendingFlat';

const useStyles = makeStyles(theme => ({
  costCard: {
    textAlign: 'center',
    height: '100%',
  },
  costValue: {
    fontSize: '2.5rem',
    fontWeight: 'bold',
    color: theme.palette.primary.main,
  },
  icon: {
    fontSize: 48,
    color: theme.palette.primary.main,
  },
  trendUp: {
    color: '#f44336',
  },
  trendDown: {
    color: '#4caf50',
  },
  trendStable: {
    color: '#9e9e9e',
  },
}));

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042'];

const getTrendIcon = (trend: string, classes: any) => {
  switch (trend) {
    case 'up':
      return <TrendingUpIcon className={classes.trendUp} />;
    case 'down':
      return <TrendingDownIcon className={classes.trendDown} />;
    case 'stable':
      return <TrendingFlatIcon className={classes.trendStable} />;
    default:
      return null;
  }
};

export const CostInsightsView = () => {
  const classes = useStyles();
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await monitoringService.getCostSummary();
        setCostSummary(data);
      } catch (error) {
        console.error('Failed to fetch cost insights:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return <LinearProgress />;
  }

  if (!costSummary) {
    return (
      <Alert severity="error">
        Failed to load cost insights. Please try again later.
      </Alert>
    );
  }

  const chartData = Object.entries(costSummary.costByCategory).map(
    ([name, value]) => ({
      name: name.charAt(0).toUpperCase() + name.slice(1),
      value,
    }),
  );

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom>
        Cost Insights & Optimization
      </Typography>

      <Grid container spacing={3} style={{ marginBottom: 32 }}>
        <Grid item xs={12} md={4}>
          <Card className={classes.costCard}>
            <CardContent>
              <AttachMoneyIcon className={classes.icon} />
              <Typography variant="h6" color="textSecondary" gutterBottom>
                Daily Cost
              </Typography>
              <Typography className={classes.costValue}>
                ${costSummary.totalDailyCost.toFixed(2)}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {costSummary.currency}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card className={classes.costCard}>
            <CardContent>
              <AttachMoneyIcon className={classes.icon} />
              <Typography variant="h6" color="textSecondary" gutterBottom>
                Monthly Cost
              </Typography>
              <Typography className={classes.costValue}>
                ${costSummary.totalMonthlyCost.toLocaleString()}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {costSummary.currency}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card className={classes.costCard}>
            <CardContent>
              <AttachMoneyIcon className={classes.icon} />
              <Typography variant="h6" color="textSecondary" gutterBottom>
                Yearly Projection
              </Typography>
              <Typography className={classes.costValue}>
                ${costSummary.totalYearlyCost.toLocaleString()}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {costSummary.currency}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Grid container spacing={3} style={{ marginBottom: 32 }}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Cost Distribution by Category
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }) =>
                      `${name} ${(percent * 100).toFixed(0)}%`
                    }
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {chartData.map((_entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={COLORS[index % COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Top Cost Services
              </Typography>
              {costSummary.topCostServices.map((service, index) => (
                <Box
                  key={index}
                  mb={2}
                  p={2}
                  style={{ backgroundColor: '#f5f5f5', borderRadius: 4 }}
                >
                  <Box
                    display="flex"
                    justifyContent="space-between"
                    alignItems="center"
                    mb={1}
                  >
                    <Typography variant="body1" style={{ fontWeight: 'bold' }}>
                      {service.service}
                    </Typography>
                    <Box display="flex" alignItems="center">
                      {getTrendIcon(service.trend, classes)}
                      <Typography variant="h6" style={{ marginLeft: 8 }}>
                        ${service.monthlyCost.toLocaleString()}
                      </Typography>
                    </Box>
                  </Box>
                  <Typography variant="caption" color="textSecondary">
                    {service.resourceType} • ${service.dailyCost.toFixed(2)}/day
                  </Typography>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Typography variant="h5" gutterBottom>
        Detailed Cost Breakdown
      </Typography>

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Service</TableCell>
              <TableCell>Resource Type</TableCell>
              <TableCell align="right">Daily Cost</TableCell>
              <TableCell align="right">Monthly Cost</TableCell>
              <TableCell>Trend</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {costSummary.breakdown.map((item, index) => (
              <TableRow key={index} hover>
                <TableCell>{item.service}</TableCell>
                <TableCell>
                  <Chip label={item.resourceType} size="small" />
                </TableCell>
                <TableCell align="right">
                  ${item.dailyCost.toFixed(2)}
                </TableCell>
                <TableCell align="right" style={{ fontWeight: 'bold' }}>
                  ${item.monthlyCost.toLocaleString()}
                </TableCell>
                <TableCell>
                  <Box display="flex" alignItems="center">
                    {getTrendIcon(item.trend, classes)}
                    <Typography variant="caption" style={{ marginLeft: 4 }}>
                      {item.trend}
                    </Typography>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Alert severity="info" style={{ marginTop: 24 }}>
        <strong>Optimization Tip:</strong> Consider implementing auto-scaling
        for services with stable workloads to reduce costs. Services showing
        upward trend should be monitored closely for optimization opportunities.
      </Alert>
    </Box>
  );
};
