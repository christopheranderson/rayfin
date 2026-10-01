/**
 * Fabric user-hint detection.
 *
 * The AppBackend host stamps an opaque `?_fu=` hint onto the embedded iframe URL, and the workload's
 * static-hosting gate compares it against the hint sealed into the serve cookie. Its presence is the
 * SDK's signal that **the host is new enough for cross-user protection to exist server-side**, and
 * therefore that a persisted session may safely be resumed.
 *
 * When it is absent — an older AppBackend that does not stamp it, or a host that could not resolve
 * the signed-in user — no server-side comparison is happening, so the SDK falls back to the original
 * behaviour: discard any persisted session and run a full handoff on every embedded load. That is
 * slower, but it is the only thing standing between a previous Fabric user's session and the current
 * one on a host that cannot help.
 *
 * The URL value is captured eagerly at module load, so a client-side navigation that strips the query
 * string does not make the SDK think the host got older mid-session and start signing the user out.
 *
 * That capture is deliberately held in module state rather than `sessionStorage`. Storage outlives a
 * document, so a hint from an earlier load would still answer for a load the host never stamped — for
 * example after a user switch where identity resolution failed — and the SDK would resume a persisted
 * session that no server-side comparison ever vetted. Module state dies with the document, which is
 * exactly the lifetime this signal is allowed to have.
 *
 * @internal Not exported from the package barrel.
 */

const USER_HINT_QUERY_PARAM = '_fu';

// Scoped to this document. See the note above on why this is not persisted.
let hintSeenThisDocument = false;

/**
 * Captures the `?_fu=` value from the current URL.
 *
 * Called once at module load to snapshot the entry URL. Also the in-package injection point for
 * tests; it is not exported from the barrel, so app code cannot use it to fake the signal.
 *
 * @returns `true` when the URL carried a hint, whether or not it had already been captured.
 */
export function persistFabricUserHintFromUrl(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const hint = new URLSearchParams(window.location.search).get(
      USER_HINT_QUERY_PARAM
    );
    if (hint) {
      hintSeenThisDocument = true;
      return true;
    }
  } catch {
    // window.location may be unavailable in some non-browser hosts.
  }
  return false;
}

// Captured at module load so a session resumed before any auth call still sees the hint.
persistFabricUserHintFromUrl();

/**
 * Whether the host stamped a Fabric user hint for this app.
 *
 * Reports the entry URL captured at module load and nothing else. It deliberately does not re-read
 * the live URL: on the client the hint's *presence* suppresses the cross-user sign-out, so a value
 * added after load - by app routing, a query-preserving link, or anything else the gate never saw -
 * would let the page vouch for itself. The server-side comparison has the opposite polarity, where a
 * forged hint can only force a re-authentication, so this direction is the one that has to be sealed.
 *
 * @returns `true` when server-side identity gating is in play and a persisted session may be reused.
 */
export function hasFabricUserHint(): boolean {
  return hintSeenThisDocument;
}

/**
 * Clears the captured hint.
 *
 * @internal Test helper.
 */
export function clearFabricUserHint(): void {
  hintSeenThisDocument = false;
}
