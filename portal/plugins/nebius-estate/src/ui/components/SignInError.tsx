/**
 * What the sign-in page shows when it cannot sign in. A backend that does not answer (restarting, down, network)
 * is not a sign-in problem: it says "backend unreachable" and offers a retry, instead of Backstage's generic
 * "You do not appear to be signed in".
 */
export function signInFailure(error: Error): 'backend-unreachable' | 'not-signed-in' {
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed|ECONNREFUSED|network request failed/i.test(error.message)) return 'backend-unreachable';
  if (/\b(502|503|504)\b/.test(error.message)) return 'backend-unreachable';
  return 'not-signed-in';
}

export function SignInError({ error = new Error('Sign-in failed.') }: { error?: Error }) {
  const kind = signInFailure(error);
  return (
    <main className="ne-page ne-root" id="main">
      <header className="ne-header">
        <h1 className="ne-title">{kind === 'backend-unreachable' ? 'Portal backend unreachable' : 'Not signed in'}</h1>
      </header>
      <div className="ne-callout ne-tone-danger" role="alert">
        <p style={{ marginTop: 0 }}>
          {kind === 'backend-unreachable'
            ? 'The Nebius Estate backend did not answer, so the portal cannot sign you in or load data. It may be restarting; nothing is wrong with your session.'
            : 'The sign-in provider refused the session. Sign in again, or ask a platform admin to check the auth configuration (docs/portal/security.md).'}
        </p>
        <p className="ne-mono ne-faint" style={{ fontSize: '0.75rem' }}>
          {error.message}
        </p>
        <button type="button" className="ne-btn ne-btn-sm" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    </main>
  );
}
