import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Grid,
  LinearProgress,
  MenuItem,
  TextField,
  Typography,
  makeStyles,
} from '@material-ui/core';
import CloudUploadIcon from '@material-ui/icons/CloudUpload';
import {
  DHIS2Instance,
  DumpFormat,
  ProxmoxStorage,
  RestoreSource,
} from '../types';
import {
  detectDumpFormat,
  restoreService,
  VzdumpBackup,
} from '../services/restoreService';
import { dhis2Service } from '../services/dhis2Service';
import { settingsService } from '../services/settingsService';

const useStyles = makeStyles(theme => ({
  field: { marginBottom: theme.spacing(2) },
  uploadBox: {
    border: `2px dashed ${theme.palette.divider}`,
    borderRadius: 4,
    padding: theme.spacing(3),
    textAlign: 'center',
    cursor: 'pointer',
    '&:hover': { borderColor: theme.palette.primary.main },
  },
  uploadActive: {
    borderColor: theme.palette.primary.main,
    backgroundColor: theme.palette.action.hover,
  },
  hiddenInput: { display: 'none' },
}));

export type RestoreSourceKind = RestoreSource['kind'];

const KIND_OPTIONS: { value: RestoreSourceKind; label: string }[] = [
  { value: 'upload', label: 'Upload a dump file' },
  { value: 'url', label: 'Fetch from URL (HTTP/HTTPS)' },
  { value: 's3', label: 'Download from S3 / S3-compatible' },
  { value: 'instance', label: 'Clone from existing instance' },
  { value: 'vzdump', label: 'Restore from Proxmox backup (vzdump)' },
  { value: 'local', label: 'Local path on Proxmox host' },
];

const FORMAT_OPTIONS: { value: DumpFormat; label: string }[] = [
  { value: 'plain', label: 'Plain SQL  (.sql / .sql.gz / .sql.zst)' },
  { value: 'custom', label: 'Custom  (pg_restore -Fc, .dump)' },
  { value: 'directory', label: 'Directory  (pg_restore -Fd, .tar/.tar.gz)' },
];

export interface RestoreSourcePickerProps {
  value: RestoreSource | undefined;
  onChange: (next: RestoreSource | undefined) => void;
  /**
   * Optional list of available Proxmox nodes. When omitted the picker
   * fetches them itself on first render of node-aware source kinds.
   */
  nodes?: { node: string }[];
}

/**
 * Default skeleton for a freshly-picked source kind. Used to seed
 * `onChange` so downstream consumers can rely on `value.kind`.
 */
function defaultForKind(kind: RestoreSourceKind): RestoreSource {
  switch (kind) {
    case 'upload':
      return { kind: 'upload', uploadToken: '', originalFilename: '', sizeBytes: 0, format: 'custom' };
    case 'url':
      return { kind: 'url', url: '', format: 'custom' };
    case 's3': {
      const { dhis2 } = settingsService.load();
      const bucketSetting = dhis2.backupBucket ?? '';
      // Parse s3://bucket/path/prefix into bucket + key prefix
      let bucket = '';
      let key = '';
      const match = bucketSetting.match(/^s3:\/\/([^/]+)\/?(.*)$/);
      if (match) {
        bucket = match[1];
        key = match[2] ?? '';
      }
      return {
        kind: 's3',
        bucket,
        key,
        format: 'custom',
        useSettingsCredentials: Boolean(bucketSetting),
      };
    }
    case 'instance':
      return { kind: 'instance', sourceInstanceId: '', includeFiles: false };
    case 'vzdump':
      return { kind: 'vzdump', node: '', storage: '', volid: '' };
    case 'local':
      return { kind: 'local', node: '', path: '', format: 'custom' };
    default:
      return { kind: 'url', url: '', format: 'custom' };
  }
}

export const RestoreSourcePicker = (props: RestoreSourcePickerProps) => {
  const classes = useStyles();
  const { value, onChange, nodes = [] } = props;

  const kind: RestoreSourceKind = value?.kind ?? 'upload';

  // Initial seed so the parent doesn't have to.
  useEffect(() => {
    if (!value) onChange(defaultForKind('upload'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKindChange = (next: RestoreSourceKind) => {
    onChange(defaultForKind(next));
  };

  return (
    <Box>
      <TextField
        fullWidth
        select
        label="Backup source"
        value={kind}
        onChange={e => handleKindChange(e.target.value as RestoreSourceKind)}
        className={classes.field}
      >
        {KIND_OPTIONS.map(o => (
          <MenuItem key={o.value} value={o.value}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>

      {value?.kind === 'upload' && (
        <UploadSource value={value} onChange={onChange} />
      )}
      {value?.kind === 'url' && <UrlSource value={value} onChange={onChange} />}
      {value?.kind === 's3' && <S3Source value={value} onChange={onChange} />}
      {value?.kind === 'instance' && (
        <InstanceSource value={value} onChange={onChange} />
      )}
      {value?.kind === 'vzdump' && (
        <VzdumpSource value={value} onChange={onChange} nodes={nodes} />
      )}
      {value?.kind === 'local' && (
        <LocalSource value={value} onChange={onChange} nodes={nodes} />
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Per-kind sub-components.  Kept inside the same file because they all share
// the same `useStyles()` and have no value outside the picker.
// ---------------------------------------------------------------------------

interface SubProps<K extends RestoreSourceKind> {
  value: Extract<RestoreSource, { kind: K }>;
  onChange: (next: RestoreSource) => void;
}

const FormatSelect = (props: {
  value: DumpFormat;
  onChange: (next: DumpFormat) => void;
  className?: string;
}) => (
  <TextField
    fullWidth
    select
    label="Dump format"
    value={props.value}
    onChange={e => props.onChange(e.target.value as DumpFormat)}
    className={props.className}
    helperText="Detected from the filename when possible; override if needed."
  >
    {FORMAT_OPTIONS.map(o => (
      <MenuItem key={o.value} value={o.value}>
        {o.label}
      </MenuItem>
    ))}
  </TextField>
);

const UploadSource = ({ value, onChange }: SubProps<'upload'>) => {
  const classes = useStyles();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    setProgress(0);
    const fmt = detectDumpFormat(file.name);
    try {
      const result = await restoreService.uploadDump(file, (loaded, total) => {
        if (total > 0) setProgress(Math.round((loaded / total) * 100));
      });
      onChange({
        kind: 'upload',
        uploadToken: result.uploadToken,
        originalFilename: file.name,
        sizeBytes: result.sizeBytes,
        format: fmt,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <Box>
      <Box
        className={`${classes.uploadBox} ${dragActive ? classes.uploadActive : ''}`}
        onDragOver={e => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('dhis2-restore-upload-input')?.click()}
      >
        <CloudUploadIcon fontSize="large" color="action" />
        <Typography variant="body1">
          {value.uploadToken
            ? `Uploaded: ${value.originalFilename} (${(value.sizeBytes / 1024 ** 2).toFixed(1)} MB)`
            : 'Click or drag a dump file here (.sql, .sql.gz, .dump, .backup, .tar.gz)'}
        </Typography>
        <input
          id="dhis2-restore-upload-input"
          type="file"
          accept=".sql,.gz,.zst,.bz2,.dump,.backup,.tar,.pgdump"
          className={classes.hiddenInput}
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            // allow re-selecting the same file
            e.target.value = '';
          }}
        />
      </Box>
      {uploading && (
        <Box mt={1}>
          <LinearProgress variant="determinate" value={progress} />
          <Typography variant="caption" color="textSecondary">
            Uploading… {progress}%
          </Typography>
        </Box>
      )}
      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
      <Box mt={2}>
        <FormatSelect
          value={value.format}
          onChange={fmt => onChange({ ...value, format: fmt })}
          className={classes.field}
        />
      </Box>
    </Box>
  );
};

const UrlSource = ({ value, onChange }: SubProps<'url'>) => {
  const classes = useStyles();
  const [headersText, setHeadersText] = useState(() =>
    value.headers ? JSON.stringify(value.headers, null, 2) : '',
  );
  const [headersError, setHeadersError] = useState<string | null>(null);

  return (
    <Box>
      <TextField
        fullWidth
        label="Dump URL"
        value={value.url}
        onChange={e => {
          const url = e.target.value;
          const fmt = url ? detectDumpFormat(url.split('?')[0]) : value.format;
          onChange({ ...value, url, format: fmt });
        }}
        className={classes.field}
        helperText="e.g. https://backups.example.com/dhis2-2026-05-01.dump"
        required
      />
      <FormatSelect
        value={value.format}
        onChange={fmt => onChange({ ...value, format: fmt })}
        className={classes.field}
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label="Custom request headers (JSON, optional)"
        value={headersText}
        onChange={e => {
          const text = e.target.value;
          setHeadersText(text);
          if (!text.trim()) {
            setHeadersError(null);
            onChange({ ...value, headers: undefined });
            return;
          }
          try {
            const parsed = JSON.parse(text) as Record<string, string>;
            setHeadersError(null);
            onChange({ ...value, headers: parsed });
          } catch (err) {
            setHeadersError((err as Error).message);
          }
        }}
        className={classes.field}
        helperText={headersError ?? 'e.g. {"Authorization": "Bearer …"}'}
        error={Boolean(headersError)}
      />
    </Box>
  );
};

const S3Source = ({ value, onChange }: SubProps<'s3'>) => {
  const classes = useStyles();
  const { dhis2 } = settingsService.load();
  const hasSettingsBucket = Boolean(dhis2.backupBucket);

  return (
    <Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Bucket"
            value={value.bucket}
            onChange={e => onChange({ ...value, bucket: e.target.value })}
            className={classes.field}
            required
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            label="Object key"
            value={value.key}
            onChange={e => {
              const key = e.target.value;
              const fmt = key ? detectDumpFormat(key) : value.format;
              onChange({ ...value, key, format: fmt });
            }}
            className={classes.field}
            helperText="path/to/dhis2-2026-05-01.dump"
            required
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            label="Region"
            value={value.region ?? ''}
            onChange={e => onChange({ ...value, region: e.target.value })}
            className={classes.field}
            helperText="e.g. eu-west-1"
          />
        </Grid>
        <Grid item xs={12} md={8}>
          <TextField
            fullWidth
            label="Endpoint (optional)"
            value={value.endpoint ?? ''}
            onChange={e => onChange({ ...value, endpoint: e.target.value })}
            className={classes.field}
            helperText="Leave blank for AWS. For MinIO/R2/Wasabi set the endpoint URL."
          />
        </Grid>
      </Grid>
      <FormatSelect
        value={value.format}
        onChange={fmt => onChange({ ...value, format: fmt })}
        className={classes.field}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={Boolean(value.useSettingsCredentials)}
            onChange={e =>
              onChange({ ...value, useSettingsCredentials: e.target.checked })
            }
            disabled={!hasSettingsBucket}
          />
        }
        label={
          hasSettingsBucket
            ? 'Use credentials from plugin Settings (offsite backup bucket)'
            : 'No offsite bucket configured in Settings'
        }
      />
      {!value.useSettingsCredentials && (
        <Grid container spacing={2} style={{ marginTop: 8 }}>
          <Grid item xs={12} md={6}>
            <TextField
              fullWidth
              label="Access key ID"
              value={value.accessKeyId ?? ''}
              onChange={e => onChange({ ...value, accessKeyId: e.target.value })}
              className={classes.field}
              required
            />
          </Grid>
          <Grid item xs={12} md={6}>
            <TextField
              fullWidth
              type="password"
              label="Secret access key"
              value={value.secretAccessKey ?? ''}
              onChange={e => onChange({ ...value, secretAccessKey: e.target.value })}
              className={classes.field}
              required
            />
          </Grid>
        </Grid>
      )}
    </Box>
  );
};

const InstanceSource = ({ value, onChange }: SubProps<'instance'>) => {
  const classes = useStyles();
  const [instances, setInstances] = useState<DHIS2Instance[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    restoreService
      .listManagedInstances()
      .then(list => {
        if (!cancelled) setInstances(list);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box>
      {loading ? (
        <Box display="flex" alignItems="center" style={{ gap: 8 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading instances…</Typography>
        </Box>
      ) : (
        <TextField
          fullWidth
          select
          label="Source instance to clone"
          value={value.sourceInstanceId}
          onChange={e => onChange({ ...value, sourceInstanceId: e.target.value })}
          className={classes.field}
          required
          helperText="Only running instances are listed (live pg_dump)."
        >
          {instances.length === 0 ? (
            <MenuItem value="" disabled>
              No running instances available
            </MenuItem>
          ) : (
            instances.map(i => (
              <MenuItem key={i.id} value={i.id}>
                {i.name} — {i.version} ({i.database.name})
              </MenuItem>
            ))
          )}
        </TextField>
      )}
      <FormControlLabel
        control={
          <Checkbox
            checked={Boolean(value.includeFiles)}
            onChange={e => onChange({ ...value, includeFiles: e.target.checked })}
          />
        }
        label="Also copy the DHIS2 files dir (uploaded resources)"
      />
    </Box>
  );
};

interface NodeAwareProps<K extends 'vzdump' | 'local'> extends SubProps<K> {
  nodes: { node: string }[];
}

const VzdumpSource = ({ value, onChange, nodes }: NodeAwareProps<'vzdump'>) => {
  const classes = useStyles();
  const [storages, setStorages] = useState<ProxmoxStorage[]>([]);
  const [backups, setBackups] = useState<VzdumpBackup[]>([]);
  const [loadingStorages, setLoadingStorages] = useState(false);
  const [loadingBackups, setLoadingBackups] = useState(false);

  useEffect(() => {
    if (!value.node) {
      setStorages([]);
      return;
    }
    let cancelled = false;
    setLoadingStorages(true);
    dhis2Service
      .fetchNodeStorage(value.node)
      .then(list => {
        if (!cancelled) {
          // Only storages that hold backups
          setStorages(
            list.filter(s => (s.content ?? '').split(',').includes('backup')),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingStorages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.node]);

  useEffect(() => {
    if (!value.node || !value.storage) {
      setBackups([]);
      return;
    }
    let cancelled = false;
    setLoadingBackups(true);
    restoreService
      .listVzdumpBackups(value.node, value.storage)
      .then(list => {
        if (!cancelled) setBackups(list);
      })
      .finally(() => {
        if (!cancelled) setLoadingBackups(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value.node, value.storage]);

  const formatVolid = (b: VzdumpBackup) => {
    const date = b.ctime ? new Date(b.ctime * 1000).toISOString().slice(0, 16).replace('T', ' ') : '';
    const size = b.size ? `${(b.size / 1024 ** 3).toFixed(1)} GB` : '';
    return [b.volid, b.vmid ? `vmid=${b.vmid}` : '', date, size]
      .filter(Boolean)
      .join('  ·  ');
  };

  return (
    <Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            select
            label="Proxmox node"
            value={value.node}
            onChange={e =>
              onChange({ ...value, node: e.target.value, storage: '', volid: '' })
            }
            className={classes.field}
            required
          >
            {nodes.length === 0 ? (
              <MenuItem value="" disabled>
                No nodes available
              </MenuItem>
            ) : (
              nodes.map(n => (
                <MenuItem key={n.node} value={n.node}>
                  {n.node}
                </MenuItem>
              ))
            )}
          </TextField>
        </Grid>
        <Grid item xs={12} md={6}>
          <TextField
            fullWidth
            select
            label="Backup storage"
            value={value.storage}
            onChange={e =>
              onChange({ ...value, storage: e.target.value, volid: '' })
            }
            className={classes.field}
            required
            disabled={!value.node || loadingStorages}
            helperText={loadingStorages ? 'Loading storages…' : undefined}
          >
            {storages.length === 0 ? (
              <MenuItem value="" disabled>
                No backup-capable storage on this node
              </MenuItem>
            ) : (
              storages.map(s => (
                <MenuItem key={s.storage} value={s.storage}>
                  {s.storage} ({s.type})
                </MenuItem>
              ))
            )}
          </TextField>
        </Grid>
      </Grid>
      <TextField
        fullWidth
        select
        label="Backup archive"
        value={value.volid}
        onChange={e => onChange({ ...value, volid: e.target.value })}
        className={classes.field}
        required
        disabled={!value.storage || loadingBackups}
        helperText={loadingBackups ? 'Loading backups…' : 'Pick a DHIS2 vzdump archive.'}
      >
        {backups.length === 0 ? (
          <MenuItem value="" disabled>
            No backups found
          </MenuItem>
        ) : (
          backups.map(b => (
            <MenuItem key={b.volid} value={b.volid}>
              {formatVolid(b)}
            </MenuItem>
          ))
        )}
      </TextField>
    </Box>
  );
};

const LocalSource = ({ value, onChange, nodes }: NodeAwareProps<'local'>) => {
  const classes = useStyles();
  return (
    <Box>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <TextField
            fullWidth
            select
            label="Proxmox node"
            value={value.node}
            onChange={e => onChange({ ...value, node: e.target.value })}
            className={classes.field}
            required
          >
            {nodes.length === 0 ? (
              <MenuItem value="" disabled>
                No nodes available
              </MenuItem>
            ) : (
              nodes.map(n => (
                <MenuItem key={n.node} value={n.node}>
                  {n.node}
                </MenuItem>
              ))
            )}
          </TextField>
        </Grid>
        <Grid item xs={12} md={8}>
          <TextField
            fullWidth
            label="Absolute path on host"
            value={value.path}
            onChange={e => {
              const path = e.target.value;
              const fmt = path ? detectDumpFormat(path) : value.format;
              onChange({ ...value, path, format: fmt });
            }}
            className={classes.field}
            helperText="e.g. /var/backups/dhis2/dhis2-2026-05-01.dump"
            required
          />
        </Grid>
      </Grid>
      <FormatSelect
        value={value.format}
        onChange={fmt => onChange({ ...value, format: fmt })}
        className={classes.field}
      />
    </Box>
  );
};

// Re-export the helper button shape consumers commonly need to render
// alongside the picker (e.g. a "Clear" button on the parent dialog).
export const RestoreSourceClearButton = (props: {
  onClear: () => void;
  disabled?: boolean;
}) => (
  <Button onClick={props.onClear} disabled={props.disabled} size="small">
    Clear restore source
  </Button>
);

