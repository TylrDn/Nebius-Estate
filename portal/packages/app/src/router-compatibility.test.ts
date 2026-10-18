import { dirname, join } from 'node:path';
import { createRouteRef } from '@backstage/frontend-plugin-api';

type Resolver = {
  resolve(ref: unknown, location: unknown): ((params: Record<string, string>) => string) | undefined;
};
type ResolverModule = {
  RouteResolver: new (...args: unknown[]) => Resolver;
};

// Exercise the exact published implementations consumed by frontend-defaults.
// Internal entry points are deliberate: this guards our version-specific patch,
// without duplicating the resolver or silently testing a replacement fixture.
const dependencyPaths = [dirname(require.resolve('@backstage/frontend-defaults/package.json'))];
const resolverPath = (name: string) => join(
  dirname(require.resolve(`${name}/package.json`, { paths: dependencyPaths })),
  'dist/routing/RouteResolver.esm.js',
);
const { RouteResolver: FrontendRouteResolver } = require(resolverPath('@backstage/frontend-app-api')) as ResolverModule;
const { RouteResolver: LegacyRouteResolver } = require(resolverPath('@backstage/core-app-api')) as ResolverModule;
const { createRouteRef: createLegacyRouteRef } = require(require.resolve(
  '@backstage/core-plugin-api',
  { paths: dependencyPaths },
)) as { createRouteRef(options: { id: string; params: string[] }): unknown };

describe('Backstage route parameters with the selected React Router', () => {
  const cases = [
    ['ordinary-id', '/resources/ordinary-id'],
    ['a/b?c&d#e;f', '/resources/a%2Fb%3Fc%26d%23e%3Bf'],
    ['a%2Fb', '/resources/a%252Fb'],
    ['hello world', '/resources/hello%20world'],
  ];

  const ref = createRouteRef({ params: ['id'] });
  const frontend = new FrontendRouteResolver(
    new Map([[ref, '/resources/:id']]), new Map(), [], new Map(), '',
    (value: unknown) => value, new Map(),
  );
  const legacyRef = createLegacyRouteRef({ id: 'router-compatibility', params: ['id'] });
  const legacy = new LegacyRouteResolver(
    new Map([[legacyRef, '/resources/:id']]), new Map(), [], new Map(), '',
  );

  const splatCases = [
    ['ordinary-id', '/resources/ordinary-id'],
    ['a/b?c&d#e;f', '/resources/a%2Fb%3Fc%26d%23e%3Bf'],
    ['a%2Fb', '/resources/a%2Fb'],
    ['hello world', '/resources/hello world'],
  ];
  const splatRef = createRouteRef({ params: ['*'] });
  const frontendSplat = new FrontendRouteResolver(
    new Map([[splatRef, '/resources/*']]), new Map(), [], new Map(), '',
    (value: unknown) => value, new Map(),
  );
  const legacySplatRef = createLegacyRouteRef({ id: 'router-splat-compatibility', params: ['*'] });
  const legacySplat = new LegacyRouteResolver(
    new Map([[legacySplatRef, '/resources/*']]), new Map(), [], new Map(), '',
  );

  it.each(splatCases)('preserves frontend splat parameter %s', (value, expected) => {
    expect(frontendSplat.resolve(splatRef, { sourcePath: '/' })?.({ '*': value })).toBe(expected);
  });

  it.each(splatCases)('preserves legacy splat parameter %s', (value, expected) => {
    expect(legacySplat.resolve(legacySplatRef, '/')?.({ '*': value })).toBe(expected);
  });

  it.each(cases)('encodes frontend parameter %s exactly once', (id, expected) => {
    expect(frontend.resolve(ref, { sourcePath: '/' })?.({ id })).toBe(expected);
  });

  it.each(cases)('encodes legacy parameter %s exactly once', (id, expected) => {
    expect(legacy.resolve(legacyRef, '/')?.({ id })).toBe(expected);
  });
});
