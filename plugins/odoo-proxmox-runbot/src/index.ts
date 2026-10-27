export { odooPlugin, odooPlugin as plugin } from './plugin';
export { OdooPage } from './components/OdooPage';
export { OdooInstancesPanel } from './components/OdooInstancesPanel';
export { RunbotView } from './components/runbot/RunbotView';
export { BuildDialog } from './components/runbot/BuildDialog';
export { OdooAnsiblePanel } from './components/OdooAnsiblePanel';
export { OdooProxmoxClusterPanel } from './components/OdooProxmoxClusterPanel';
export { odooService, OdooService } from './services/odooService';
export { runbotApiRef, RunbotClient } from './api/runbotApi';
export type { RunbotApi, RunbotStats, ProjectDetails } from './api/runbotApi';
export { ansibleService, AnsibleService } from './services/ansibleService';
export { proxmoxService, ProxmoxService } from './services/proxmoxService';
export * from './types';
export { CreateInstanceDialog } from './components/CreateInstanceDialog';
export type { CreateInstanceDialogProps } from './components/CreateInstanceDialog';
export {
  ODOO_VERSIONS,
  OS_INFO,
  computeAddonsPath,
  suggestServerConfig,
  validateCreateRequest,
  checkDatabaseName,
  renderOdooConf,
  installPlaybookVars,
} from './odooConfig';
export type { OdooVersionInfo, ValidationResult } from './odooConfig';
