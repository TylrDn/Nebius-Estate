import type { ReactNode } from 'react';
import type { ResourceType } from '@internal/nebius-domain';
import { RESOURCE_TYPE_LABELS } from '@internal/nebius-domain';
import { serviceOf, type ServiceId } from './catalog';

/** One stroke glyph per service, on the portal's 24 × 24 icon grid. Decorative: the type label is always next to it. */
const GLYPHS: Record<ServiceId, ReactNode> = {
  org: (
    <>
      <path d="M4 20V8l8-4 8 4v12" />
      <path d="M9 20v-6h6v6M3 20h18" />
    </>
  ),
  compute: (
    <>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9h2.5M2.5 15h2.5M19 9h2.5M19 15h2.5" />
    </>
  ),
  kubernetes: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 6.5v3M12 14.5v3M7.2 9.2l2.6 1.5M14.2 13.3l2.6 1.5M7.2 14.8l2.6-1.5M14.2 10.7l2.6-1.5" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="18" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M12 7.2V12M12 12l-5.5 4.2M12 12l5.5 4.2" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
      <path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </>
  ),
  data: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="1.5" />
      <rect x="4" y="14" width="16" height="6" rx="1.5" />
      <path d="M8 7h.01M8 17h.01M12 10v4" />
    </>
  ),
  ai: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" />
    </>
  ),
  security: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path d="M11 11l8-8M16 6l2.5 2.5M14 8l2 2" />
    </>
  ),
};

/** Paths only, for use inside an existing <svg> (the graph). */
export function GlyphPaths({ type }: { type?: ResourceType }) {
  return <g className="ne-xglyph">{GLYPHS[type ? serviceOf(type).id : 'org']}</g>;
}

/** Glyph + type label for HTML contexts (table cells, filters). */
export function TypeLabel({ type }: { type: ResourceType }) {
  return (
    <span className="ne-xtype">
      <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <GlyphPaths type={type} />
      </svg>
      <span>{RESOURCE_TYPE_LABELS[type]}</span>
    </span>
  );
}
