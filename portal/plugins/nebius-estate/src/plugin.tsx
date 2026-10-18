import { createFrontendPlugin, createRouteRef, PageBlueprint } from '@backstage/frontend-plugin-api';
import { Icon } from './ui';

export const routes = {
  overview: createRouteRef(),
  explorer: createRouteRef(),
  capacity: createRouteRef(),
  workloads: createRouteRef(),
  provisioning: createRouteRef(),
  costs: createRouteRef(),
  commercial: createRouteRef(),
  evidence: createRouteRef(),
  integrations: createRouteRef(),
  budgets: createRouteRef(),
  aiServices: createRouteRef(),
  fleet: createRouteRef(),
  alerts: createRouteRef(),
  logs: createRouteRef(),
  solutions: createRouteRef(),
  nebiusDocs: createRouteRef(),
};

const page = (name: keyof typeof routes, path: string, title: string, icon: Parameters<typeof Icon>[0]['name'], loader: () => Promise<JSX.Element>) =>
  PageBlueprint.make({
    name,
    params: { path, title, icon: <Icon name={icon} size={18} />, routeRef: routes[name], noHeader: true, loader },
  });

export const overviewPage = page('overview', '/', 'Overview', 'overview', () => import('./pages/OverviewPage').then(m => <m.OverviewPage />));
export const explorerPage = page('explorer', '/estate', 'Estate Explorer', 'explorer', () => import('./pages/ExplorerPage').then(m => <m.ExplorerPage />));
export const capacityPage = page('capacity', '/capacity', 'GPU & Capacity', 'gpu', () => import('./pages/CapacityPage').then(m => <m.CapacityPage />));
export const workloadsPage = page('workloads', '/workloads', 'Workloads', 'workloads', () => import('./pages/WorkloadsPage').then(m => <m.WorkloadsPage />));
export const provisioningPage = page('provisioning', '/provisioning', 'Provisioning', 'provision', () => import('./pages/ProvisioningPage').then(m => <m.ProvisioningPage />));
export const costsPage = page('costs', '/costs', 'Costs', 'costs', () => import('./commercial/CostsPage').then(m => <m.CostsPage />));
export const commercialPage = page('commercial', '/commercial', 'Commercial Scenarios', 'commercial', () => import('./commercial/CommercialPage').then(m => <m.CommercialPage />));
export const evidencePage = page('evidence', '/evidence', 'Evidence & Runbooks', 'evidence', () => import('./pages/EvidencePage').then(m => <m.EvidencePage />));
export const budgetsPage = page('budgets', '/budgets', 'Budgets & credits', 'budget', () => import('./budgets/BudgetsPage').then(m => <m.BudgetsPage />));
export const aiServicesPage = page('aiServices', '/ai-services', 'AI services', 'ai', () => import('./ai/AiServicesPage').then(m => <m.AiServicesPage />));
export const fleetPage = page('fleet', '/fleet', 'Fleet', 'fleet', () => import('./telemetry/FleetPage').then(m => <m.FleetPage />));
export const alertsPage = page('alerts', '/alerts', 'Alerts', 'alert', () => import('./alerts/AlertsPage').then(m => <m.AlertsPage />));
export const logsPage = page('logs', '/logs', 'Logs', 'logs', () => import('./logs/LogsPage').then(m => <m.LogsPage />));
export const solutionsPage = page('solutions', '/solutions', 'Solutions', 'layers', () => import('./pages/SolutionsPage').then(m => <m.SolutionsPage />));
export const nebiusDocsPage = page('nebiusDocs', '/nebius-docs', 'Nebius docs', 'doc', () => import('./pages/NebiusDocsPage').then(m => <m.NebiusDocsPage />));
export const integrationsPage = page('integrations', '/integrations', 'Integrations & Coverage', 'integrations', () => import('./pages/IntegrationsPage').then(m => <m.IntegrationsPage />));

/** @public */
export const nebiusEstatePlugin = createFrontendPlugin({
  pluginId: 'nebius-estate',
  extensions: [overviewPage, explorerPage, capacityPage, workloadsPage, provisioningPage, costsPage, commercialPage, evidencePage, integrationsPage, budgetsPage, aiServicesPage, fleetPage, alertsPage, logsPage, solutionsPage, nebiusDocsPage],
  routes,
});
