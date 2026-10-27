import { Chip, Tooltip } from '@material-ui/core';
import {
  BuildLocalState,
  BuildResult,
  RunbotBuildSummary,
} from '@iswesolutions/plugin-odoo-runbot-common';

/** Runbot's colours: green ok, orange warn, red ko, grey killed/skipped, blue in progress */
export const RESULT_COLORS: Record<string, string> = {
  ok: '#2e7d32',
  warn: '#ef6c00',
  ko: '#c62828',
  killed: '#616161',
  skipped: '#9e9e9e',
  pending: '#1565c0',
  testing: '#0277bd',
  running: '#00838f',
};

export const stateLabel = (b: {
  localState: BuildLocalState;
  result?: BuildResult;
}) => (b.localState === 'done' ? b.result ?? 'done' : b.localState);

export const shortSha = (sha: string) => sha.slice(0, 8);

export const githubCommitUrl = (slug: string, sha: string) =>
  `https://github.com/${slug}/commit/${sha}`;
export const githubTreeUrl = (slug: string, branch: string) =>
  `https://github.com/${slug}/tree/${branch}`;
export const githubPrUrl = (slug: string, n: number) =>
  `https://github.com/${slug}/pull/${n}`;

export function ago(iso?: string): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(b: { started?: string; finished?: string }): string {
  if (!b.started) return '';
  const end = b.finished ? Date.parse(b.finished) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(b.started)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export const BuildChip = ({
  build,
  label,
  onClick,
}: {
  build: RunbotBuildSummary;
  label?: string;
  onClick?: () => void;
}) => {
  const state = stateLabel(build);
  return (
    <Tooltip
      title={`#${build.id} ${state}${
        build.errorSummary ? `: ${build.errorSummary}` : ''
      }${build.started ? ` · ${duration(build)}` : ''}`}
    >
      <Chip
        size="small"
        label={label ?? build.triggerName}
        onClick={onClick}
        style={{
          backgroundColor: RESULT_COLORS[state] ?? '#757575',
          color: '#fff',
          margin: 2,
        }}
      />
    </Tooltip>
  );
};
