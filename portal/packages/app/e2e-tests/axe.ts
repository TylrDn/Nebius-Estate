import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * The axe run every e2e accessibility check starts from. The pinned axe-core (4.13, through @axe-core/playwright)
 * ships `label-content-name-mismatch` (WCAG 2.5.3 Label in Name) as experimental and off; axe 4.14 turns it on, and
 * the Wave 1 verification found the Estate graph failing it there. It is enabled here, so the checks see it too.
 * Callers add `withTags` / `include` after this (`options` replaces what was set before it).
 */
export function axeBuilder(page: Page): AxeBuilder {
  return new AxeBuilder({ page }).options({ rules: { 'label-content-name-mismatch': { enabled: true } } });
}
