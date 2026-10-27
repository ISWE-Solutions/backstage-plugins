import { useEffect, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
} from '@material-ui/core';
import { Alert, Autocomplete } from '@material-ui/lab';
import { useApi } from '@backstage/core-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import {
  RunbotProject,
  RunbotRepo,
} from '@iswesolutions/plugin-odoo-runbot-common';
import { runbotApiRef } from '../../api/runbotApi';

interface Suggestion {
  title: string;
  slug: string;
  entityRef: string;
}

/** Catalog Components tagged odoo, with their GitHub slug */
function useCatalogRepos(open: boolean): Suggestion[] {
  const catalogApi = useApi(catalogApiRef);
  const [items, setItems] = useState<Suggestion[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (open) {
      catalogApi
        .getEntities({
          filter: { kind: 'Component', 'metadata.tags': 'odoo' },
          fields: [
            'kind',
            'metadata.name',
            'metadata.namespace',
            'metadata.title',
            'metadata.annotations',
          ],
        })
        .then(({ items: entities }) => {
          if (cancelled) return;
          setItems(
            entities
              .map(e => ({
                title: e.metadata.title ?? e.metadata.name,
                slug: e.metadata.annotations?.['github.com/project-slug'] ?? '',
                entityRef: stringifyEntityRef(e),
              }))
              .filter(s => s.slug)
              .sort((a, b) => a.title.localeCompare(b.title)),
          );
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [open, catalogApi]);
  return items;
}

export const NewProjectDialog = ({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: RunbotProject) => void;
}) => {
  const api = useApi(runbotApiRef);
  const [name, setName] = useState('ISWE Odoo 19');
  const [bases, setBases] = useState('19.0');
  const [master, setMaster] = useState('19.0');
  const [error, setError] = useState<string>();
  const submit = async () => {
    setError(undefined);
    try {
      const baseBranches = bases
        .split(',')
        .map(b => b.trim())
        .filter(Boolean);
      onCreated(
        await api.createProject({
          name,
          baseBranches,
          masterBase: master.trim() || baseBranches[0],
        }),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>New runbot project</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="textSecondary" paragraph>
          A project groups the repositories that are built together: odoo/odoo
          and the addons repositories of one Odoo version.
        </Typography>
        <TextField
          fullWidth
          margin="dense"
          label="Name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Base branches"
          value={bases}
          onChange={e => setBases(e.target.value)}
          helperText="Version branches, comma-separated, e.g. 19.0 or 18.0,19.0"
        />
        <TextField
          fullWidth
          margin="dense"
          label="Master base"
          value={master}
          onChange={e => setMaster(e.target.value)}
          helperText="The base of every other branch name; repositories' default branches (main) join it"
        />
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="primary" variant="contained" onClick={submit}>
          Create project
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export const AddRepositoryDialog = ({
  open,
  project,
  repos,
  onClose,
  onAdded,
}: {
  open: boolean;
  project?: RunbotProject;
  repos: RunbotRepo[];
  onClose: () => void;
  onAdded: () => void;
}) => {
  const api = useApi(runbotApiRef);
  const suggestions = useCatalogRepos(open);
  const hasServer = repos.some(r => r.isServer);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [entityRef, setEntityRef] = useState<string>();
  const [isServer, setIsServer] = useState(false);
  const [subdir, setSubdir] = useState('');
  const [createTrigger, setCreateTrigger] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) {
      setSlug(hasServer ? '' : 'odoo/odoo');
      setIsServer(!hasServer);
      setName('');
      setSubdir('');
      setEntityRef(undefined);
      setCreateTrigger(true);
      setError(undefined);
    }
  }, [open, hasServer]);

  const submit = async () => {
    if (!project) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addRepo({
        projectId: project.id,
        slug: slug.trim(),
        name: name.trim() || undefined,
        isServer,
        addonsSubdir: subdir.trim(),
        entityRef,
        createTrigger: !isServer && createTrigger,
      });
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add a repository to {project?.name}</DialogTitle>
      <DialogContent>
        {!hasServer && (
          <Alert severity="info" style={{ marginBottom: 8 }}>
            Start with odoo/odoo: every build needs the repository that provides
            odoo-bin.
          </Alert>
        )}
        <Autocomplete
          freeSolo
          options={suggestions.filter(
            s =>
              !repos.some(r => r.slug.toLowerCase() === s.slug.toLowerCase()),
          )}
          getOptionLabel={o =>
            typeof o === 'string' ? o : `${o.title} (${o.slug})`
          }
          inputValue={slug}
          onInputChange={(_, v, reason) => {
            if (reason === 'input') {
              setSlug(v);
              setEntityRef(undefined);
            }
          }}
          onChange={(_, v) => {
            if (v && typeof v !== 'string') {
              setSlug(v.slug);
              setEntityRef(v.entityRef);
            }
          }}
          renderInput={params => (
            <TextField
              {...params}
              margin="dense"
              label="GitHub repository (owner/name)"
              helperText="Type it, or pick an Odoo component from the catalog"
            />
          )}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Name"
          placeholder={slug.split('/')[1] ?? ''}
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <TextField
          fullWidth
          margin="dense"
          label="Modules folder"
          placeholder="(the repository root)"
          value={subdir}
          onChange={e => setSubdir(e.target.value)}
          disabled={isServer}
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={isServer}
              onChange={e => setIsServer(e.target.checked)}
            />
          }
          label="Provides odoo-bin (odoo/odoo)"
        />
        {!isServer && (
          <FormControlLabel
            control={
              <Checkbox
                checked={createTrigger}
                onChange={e => setCreateTrigger(e.target.checked)}
              />
            }
            label="Install and test its modules on every push (a trigger, with odoo as dependency)"
          />
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          color="primary"
          variant="contained"
          disabled={busy || !slug}
          onClick={submit}
        >
          Add repository
        </Button>
      </DialogActions>
    </Dialog>
  );
};
