import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  appThemeApiRef,
  coreExtensionData,
  createExtension,
  createExtensionInput,
  createFrontendModule,
  NotFoundErrorPage,
  useApi,
} from '@backstage/frontend-plugin-api';
import { NavContentBlueprint, SignInPageBlueprint, SwappableComponentBlueprint, ThemeBlueprint } from '@backstage/plugin-app-react';
import { createUnifiedTheme, palettes, UnifiedThemeProvider } from '@backstage/theme';
import { filterSearch, Icon, SignInError, TestDataBanner, TestDataMark, useMeta } from '@internal/backstage-plugin-nebius-estate';

/* ----------------------------------------------------------------- themes */

const darkTheme = createUnifiedTheme({
  palette: {
    ...palettes.dark,
    primary: { main: '#4cc3d9' },
    secondary: { main: '#b49cff' },
    background: { default: '#0b0e14', paper: '#11151d' },
    navigation: { ...palettes.dark.navigation, background: '#080a0f' },
  },
  defaultPageTheme: 'home',
  fontFamily: "'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
});

const lightTheme = createUnifiedTheme({
  palette: {
    ...palettes.light,
    primary: { main: '#0a7f99' },
    secondary: { main: '#7b5cd6' },
    background: { default: '#f4f6f9', paper: '#ffffff' },
  },
  defaultPageTheme: 'home',
  fontFamily: "'Inter', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
});

const nebiusDark = ThemeBlueprint.make({
  name: 'nebius-dark',
  params: {
    theme: {
      id: 'nebius-dark',
      title: 'Dark',
      variant: 'dark',
      icon: <Icon name="moon" size={16} />,
      Provider: ({ children }) => <UnifiedThemeProvider theme={darkTheme}>{children}</UnifiedThemeProvider>,
    },
  },
});

const nebiusLight = ThemeBlueprint.make({
  name: 'nebius-light',
  params: {
    theme: {
      id: 'nebius-light',
      title: 'Light',
      variant: 'light',
      icon: <Icon name="sun" size={16} />,
      Provider: ({ children }) => <UnifiedThemeProvider theme={lightTheme}>{children}</UnifiedThemeProvider>,
    },
  },
});

/* -------------------------------------------------------------------- nav */

const GROUPS: { label: string; items: string[] }[] = [
  { label: 'Operate', items: ['page:nebius-estate/overview', 'page:nebius-estate/explorer', 'page:nebius-estate/capacity', 'page:nebius-estate/fleet', 'page:nebius-estate/alerts', 'page:nebius-estate/logs', 'page:nebius-estate/workloads', 'page:nebius-estate/aiServices'] },
  { label: 'Change', items: ['page:nebius-estate/provisioning'] },
  { label: 'Finance', items: ['page:nebius-estate/costs', 'page:nebius-estate/commercial', 'page:nebius-estate/budgets'] },
  { label: 'Assurance', items: ['page:nebius-estate/evidence', 'page:nebius-estate/solutions', 'page:nebius-estate/nebiusDocs', 'page:nebius-estate/integrations'] },
];

function ThemeToggle() {
  const themes = useApi(appThemeApiRef);
  const active = themes.getActiveThemeId();
  const dark = active ? active === 'nebius-dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  return (
    <button
      type="button"
      className="ne-btn ne-btn-sm"
      onClick={() => themes.setActiveThemeId(dark ? 'nebius-light' : 'nebius-dark')}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={14} />
      <span className="ne-nav-foot-text">{dark ? 'Light theme' : 'Dark theme'}</span>
    </button>
  );
}

function UserLine() {
  const meta = useMeta();
  return meta.data ? (
    <div className="ne-nav-foot-text ne-muted" style={{ overflowWrap: 'anywhere' }} title={`Scope: ${meta.data.scope.join(', ')}`}>
      {meta.data.user}
    </div>
  ) : null;
}

/** Nav links keep the global project / region / stage filter from the current URL. */
function NavItem({ href, title, icon }: { href: string; title: string; icon: ReactNode }) {
  const { search } = useLocation();
  return (
    // On a phone only the icon shows: aria-label names the link, and the label appears beside it on focus or tap (styles.css).
    <NavLink to={{ pathname: href, search: filterSearch(search) }} end={href === '/'} className="ne-nav-link" aria-label={title}>
      {icon}
      <span className="ne-nav-link-label">{title}</span>
    </NavLink>
  );
}

const navContent = NavContentBlueprint.make({
  params: {
    component: ({ navItems }) => {
      const rest = navItems.clone();
      return (
        <nav className="ne-nav ne-root" aria-label="Primary" style={{ minHeight: 'auto' }}>
          {/* The brand is not a link: "Skip to content" already jumps to #main, and on a phone its text is hidden. */}
          <div className="ne-nav-brand">
            <span className="ne-nav-brand-mark" aria-hidden>
              <Icon name="gpu" size={16} />
            </span>
            <span className="ne-nav-brand-text">
              <span className="ne-nav-brand-name">Nebius Estate</span>
              <br />
              <span className="ne-nav-brand-sub">GPU cloud operations</span>
            </span>
          </div>
          <TestDataMark />
          {GROUPS.map(g => (
            <div className="ne-nav-group" key={g.label} role="group" aria-label={g.label}>
              <div className="ne-nav-group-label">{g.label}</div>
              {g.items.map(id => {
                const item = rest.take(id);
                if (!item) return null;
                return <NavItem key={id} href={item.href} title={item.title} icon={item.icon} />;
              })}
            </div>
          ))}
          <div className="ne-nav-foot">
            <ThemeToggle />
            <UserLine />
          </div>
        </nav>
      );
    },
  },
});

/* ----------------------------------------------------------------- layout */

/** Replaces the default layout (which pads for Backstage's fixed sidebar) with a plain flex shell. */
const layout = createExtension({
  name: 'layout',
  attachTo: { id: 'app/root', input: 'children' },
  inputs: {
    nav: createExtensionInput([coreExtensionData.reactElement], { singleton: true }),
    content: createExtensionInput([coreExtensionData.reactElement], { singleton: true }),
  },
  output: [coreExtensionData.reactElement],
  factory: ({ inputs }) => [
    coreExtensionData.reactElement(
      // ne-shell: the nav's colour continues below it on a long page (no grey slab under the sticky nav).
      <div className="ne-shell" style={{ display: 'flex', minHeight: '100vh', alignItems: 'stretch' }}>
        {/* Out of sight until focused, then on screen: a focused link nobody can see is a trap (W1F.S1). */}
        <a href="#main" className="ne-sr-only ne-skip">
          Skip to content
        </a>
        {inputs.nav.get(coreExtensionData.reactElement)}
        <div style={{ flex: 1, minWidth: 0 }} className="ne-root">
          {inputs.content.get(coreExtensionData.reactElement)}
        </div>
      </div>,
    ),
  ],
});

/* ---------------------------------------------------------------- sign-in */

/**
 * Local sign-in: the guest provider through ProxiedSignInPage (silent, no
 * dialogs), accepted only by a loopback-only backend (app-config.local.yaml).
 * A served deployment replaces `provider` with its real sign-in provider
 * (docs/portal/security.md); its backend refuses to start with guest.
 */
const signIn = SignInPageBlueprint.make({
  params: {
    loader: async () => {
      const { ProxiedSignInPage } = await import('@backstage/core-components');
      // A backend that does not answer reads "backend unreachable", not "You do not appear to be signed in".
      return props => <ProxiedSignInPage {...props} provider="guest" ErrorComponent={SignInError} />;
    },
  },
});

/* -------------------------------------------------------------- not found */

/** Unknown routes stay inside the portal's own look and point back to its pages; a stub run says so here too (W1F.F1.29b). */
function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="ne-root">
      <main className="ne-page" id="main">
        <header className="ne-header">
          <TestDataBanner />
          <h1 className="ne-title">Page not found</h1>
        </header>
        <p className="ne-muted">
          Nothing in Nebius Estate lives at <span className="ne-mono">{pathname}</span>.
        </p>
        <p>
          <NavLink to="/">Go to the Overview</NavLink> or pick a page from the navigation.
        </p>
      </main>
    </div>
  );
}

const notFound = SwappableComponentBlueprint.make({
  name: 'not-found-error-page',
  params: define => define({ component: NotFoundErrorPage, loader: () => NotFound }),
});

export const nebiusAppModule = createFrontendModule({
  pluginId: 'app',
  extensions: [nebiusDark, nebiusLight, navContent, layout, signIn, notFound],
});
