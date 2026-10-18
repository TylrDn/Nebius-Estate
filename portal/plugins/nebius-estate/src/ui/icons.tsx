import type { ReactNode } from 'react';

/** Small stroke icon set drawn for this portal (24 × 24 grid, 1.7 px stroke). */
export type IconName =
  | 'fleet'
  | 'alert'
  | 'logs'
  | 'overview'
  | 'explorer'
  | 'gpu'
  | 'workloads'
  | 'provision'
  | 'costs'
  | 'commercial'
  | 'evidence'
  | 'integrations'
  | 'search'
  | 'close'
  | 'warn'
  | 'info'
  | 'lock'
  | 'clock'
  | 'unavailable'
  | 'check'
  | 'download'
  | 'refresh'
  | 'graph'
  | 'table'
  | 'chevron'
  | 'sort'
  | 'doc'
  | 'layers'
  | 'plus'
  | 'print'
  | 'moon'
  | 'sun'
  | 'budget'
  | 'ai';

const PATHS: Record<IconName, ReactNode> = {
  fleet: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9 4.5v15M14.5 4.5v15" />
    </>
  ),
  alert: (
    <>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  logs: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M7 8.5h2M11 8.5h6M7 12h2M11 12h4M7 15.5h2M11 15.5h6" />
    </>
  ),
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  explorer: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8 7.5l3 8M16 7.5l-3 8M8.5 6h7" />
    </>
  ),
  gpu: (
    <>
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <rect x="8" y="9.5" width="8" height="5" rx="1" />
      <path d="M8 3v3M12 3v3M16 3v3M8 18v3M12 18v3M16 18v3" />
    </>
  ),
  workloads: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </>
  ),
  provision: (
    <>
      <path d="M5 12h14M12 5v14" />
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    </>
  ),
  costs: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  commercial: (
    <>
      <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20z" />
      <path d="M15 3.5V8h4M9 12h7M9 15.5h7M9 8.5h3" />
    </>
  ),
  evidence: (
    <>
      <path d="M9 4.5h6M9 4.5a1.5 1.5 0 0 0 0 3h6a1.5 1.5 0 0 0 0-3" />
      <path d="M15 6h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3" />
      <path d="M9 14l2 2 4-4.5" />
    </>
  ),
  integrations: (
    <>
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  warn: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4.5M12 17.5v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  unavailable: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 18L18 6" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  download: (
    <>
      <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  graph: (
    <>
      <rect x="9" y="3.5" width="6" height="4.5" rx="1" />
      <rect x="3" y="16" width="6" height="4.5" rx="1" />
      <rect x="15" y="16" width="6" height="4.5" rx="1" />
      <path d="M12 8v4M6 16v-4h12v4" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  sort: <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />,
  doc: (
    <>
      <path d="M6.5 3.5h7.5l4 4v12.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />
      <path d="M9 12h6M9 15.5h6" />
    </>
  ),
  // Stacked layers: a solution composes several recipes (F1.23 review: "doc" read the same as "commercial" in the icon rail).
  layers: (
    <>
      <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="M3.5 12l8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  print: (
    <>
      <path d="M7 9V3.5h10V9" />
      <rect x="3.5" y="9" width="17" height="7.5" rx="1.5" />
      <path d="M7 14h10v6.5H7z" />
    </>
  ),
  moon: <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />,
  budget: (
    <>
      <rect x="3.5" y="6" width="17" height="13" rx="2" />
      <path d="M3.5 10h17M16 14.5h1.5M7 3.5h10" />
    </>
  ),
  ai: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
      <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3M10 10h4v4h-4z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
};

export function Icon({ name, size = 16, title, className }: { name: IconName; size?: number; title?: string; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
