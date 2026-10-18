// Node 24.22 includes the native ObjectWrap cleanup fix needed by SQLite.
// Keep this boundary aligned with package.json and the pinned .nvmrc/image.
export function supportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor] = match.map(Number);
  return major === 22 || (major === 24 && minor >= 22);
}
