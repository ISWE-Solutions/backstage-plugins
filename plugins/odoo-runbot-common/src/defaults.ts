import { InstallTestStep } from './types';

/** Install every module of the tested repos with demo data and run their tests */
export const defaultInstallTestStep = (): InstallTestStep => ({
  type: 'install_test',
  modules: ['*'],
  excludeModules: [],
  testTags: '',
  demo: true,
  timeout: 3600,
});

/** ci/runbot-<name>, the GitHub status context of a trigger */
export const ciContextFor = (triggerName: string) =>
  `ci/runbot-${triggerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
