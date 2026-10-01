/**
 * MailDev REST API helper for E2E tests
 *
 * MailDev provides a local SMTP server for testing email functionality.
 * This helper interacts with the MailDev REST API to retrieve and manage test emails.
 *
 * MailDev REST API endpoints:
 * - GET /email - Get all emails
 * - GET /email/:id - Get a specific email by ID
 * - DELETE /email/all - Delete all emails
 * - DELETE /email/:id - Delete a specific email
 */

// Default MailDev web UI port - can be overridden by environment variable
// The CLI may dynamically allocate different ports to avoid conflicts
const MAILDEV_PORT = process.env.MAILDEV_WEB_PORT || '1080';
const MAILDEV_URL = `http://localhost:${MAILDEV_PORT}`;
// Also check the alternate port that's commonly used when 1080 is taken
const MAILDEV_ALT_PORT = '1081';
const MAILDEV_ALT_URL = `http://localhost:${MAILDEV_ALT_PORT}`;

/**
 * Network error codes indicating a transient connection failure that should be retried.
 * MailDev (an Express server) closes idle keep-alive sockets unilaterally, so Node's
 * fetch pool occasionally reuses a half-closed socket and throws ECONNRESET / UND_ERR_SOCKET.
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Return true if the given error looks like a transient network failure worth retrying.
 * Walks the `cause` chain because `fetch` wraps the underlying undici error.
 */
function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  // Bound the walk to avoid cycles.
  for (let i = 0; i < 5 && current; i++) {
    if (typeof current === 'object' && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Issue an HTTP request to MailDev with retry on transient network failures.
 * Uses `Connection: close` to avoid Node's fetch keep-alive pool reusing a half-closed
 * socket that MailDev has silently dropped.
 * @param input - Request URL
 * @param init - Fetch init (method, etc.)
 * @param retries - Total attempts (default 3)
 * @returns The Response
 */
async function fetchMailDev(
  input: string,
  init: RequestInit = {},
  retries = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fetch(input, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Connection: 'close',
        },
      });
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === retries - 1) {
        throw err;
      }
      // Drop any cached URL so the next attempt re-probes both ports.
      activeMailDevUrl = null;
      const backoffMs = 200 * (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

/**
 * Email address object from MailDev
 */
export interface MailDevAddress {
  address: string;
  name: string;
}

/**
 * Email message from MailDev REST API
 */
export interface MailDevEmail {
  id: string;
  time: string;
  from: MailDevAddress[];
  to: MailDevAddress[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  read: boolean;
  messageId: string;
  priority: string;
}

/**
 * Check if MailDev is currently available
 * Tries the primary port first, then the alternate port
 * @returns The working URL if available, null otherwise
 */
async function findMailDevUrl(): Promise<string | null> {
  // Try primary URL first
  try {
    const response = await fetch(`${MAILDEV_URL}/email`, {
      signal: AbortSignal.timeout(3000),
      headers: { Connection: 'close' },
    });
    if (response.ok) {
      return MAILDEV_URL;
    }
  } catch {
    // Try alternate URL
  }

  // Try alternate URL
  try {
    const response = await fetch(`${MAILDEV_ALT_URL}/email`, {
      signal: AbortSignal.timeout(3000),
      headers: { Connection: 'close' },
    });
    if (response.ok) {
      return MAILDEV_ALT_URL;
    }
  } catch {
    // MailDev not available
  }

  return null;
}

// Cache the working URL
let activeMailDevUrl: string | null = null;

/**
 * Get the active MailDev URL
 * @returns The MailDev URL that's currently working
 * @throws Error if MailDev is not available
 */
async function getMailDevUrl(): Promise<string> {
  if (activeMailDevUrl) {
    return activeMailDevUrl;
  }

  const url = await findMailDevUrl();
  if (!url) {
    throw new Error('MailDev is not available');
  }

  activeMailDevUrl = url;
  console.log(`📧 Using MailDev at: ${url}`);
  return url;
}

/**
 * Check if MailDev is currently available
 * @returns true if MailDev responds to requests, false otherwise
 */
export async function isMailDevAvailable(): Promise<boolean> {
  const url = await findMailDevUrl();
  if (url) {
    activeMailDevUrl = url;
    return true;
  }
  return false;
}

/**
 * Wait for MailDev to be available
 * @param timeoutMs - Maximum time to wait (default 30 seconds)
 * @throws Error if MailDev is not available within timeout
 */
export async function waitForMailDev(timeoutMs = 30_000): Promise<void> {
  const startTime = Date.now();
  const pollIntervalMs = 1000;

  while (Date.now() - startTime < timeoutMs) {
    const url = await findMailDevUrl();
    if (url) {
      activeMailDevUrl = url;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `MailDev did not become available within ${timeoutMs / 1000} seconds`
  );
}

/**
 * Get all emails from MailDev
 * @returns Array of email messages
 */
export async function getAllEmails(): Promise<MailDevEmail[]> {
  const url = await getMailDevUrl();
  const response = await fetchMailDev(`${url}/email`);
  if (!response.ok) {
    throw new Error(`Failed to get emails: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get emails sent to a specific address
 * @param toEmail - The recipient email address to filter by
 * @returns Array of email messages sent to the specified address
 */
export async function getEmailsTo(toEmail: string): Promise<MailDevEmail[]> {
  const emails = await getAllEmails();
  return emails.filter((email) =>
    email.to.some(
      (addr) => addr.address.toLowerCase() === toEmail.toLowerCase()
    )
  );
}

/**
 * Wait for an email to arrive for a specific recipient
 * @param toEmail - The recipient email address to wait for
 * @param options - Options for waiting
 * @returns The email message
 * @throws Error if email doesn't arrive within timeout
 */
export async function waitForEmail(
  toEmail: string,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    subjectContains?: string;
  } = {}
): Promise<MailDevEmail> {
  const { timeoutMs = 30_000, pollIntervalMs = 500, subjectContains } = options;
  const startTime = Date.now();
  let lastTransientError: unknown;

  while (Date.now() - startTime < timeoutMs) {
    let emails: MailDevEmail[];
    try {
      emails = await getEmailsTo(toEmail);
      lastTransientError = undefined;
    } catch (err) {
      // A transient network blip (MailDev dropped a keep-alive socket, brief
      // restart, etc.) shouldn't abort the whole wait. Keep polling until the
      // timeout and only surface the error if we never succeed.
      if (!isTransientNetworkError(err)) {
        throw err;
      }
      lastTransientError = err;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    // Filter by subject if specified
    const matchingEmails = subjectContains
      ? emails.filter((e) =>
          e.subject.toLowerCase().includes(subjectContains.toLowerCase())
        )
      : emails;

    if (matchingEmails.length > 0) {
      // Return the most recent email
      return matchingEmails.sort(
        (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()
      )[0];
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const suffix = subjectContains
    ? ` with subject containing "${subjectContains}"`
    : '';
  if (lastTransientError) {
    throw new Error(
      `No email received for ${toEmail}${suffix} within ${timeoutMs / 1000} seconds ` +
        `(last MailDev error: ${String(lastTransientError)})`
    );
  }
  throw new Error(
    `No email received for ${toEmail}${suffix} within ${timeoutMs / 1000} seconds`
  );
}

/**
 * Extract a token from an email body
 * Looks for common patterns:
 * - ?token=XXX or &token=XXX (email verification)
 * - ?resetToken=XXX or &resetToken=XXX (password reset)
 * @param email - The email message to extract token from
 * @returns The extracted token
 * @throws Error if no token found
 */
export function extractTokenFromEmail(email: MailDevEmail): string {
  // Try to extract from HTML first (more reliable formatting)
  const content = email.html || email.text;

  // Pattern: ?token=<token> or ?resetToken=<token> (captures the token value)
  // Tokens are typically URL-safe base64 or hex strings
  const tokenMatch = content.match(/[?&](?:reset)?[Tt]oken=([A-Za-z0-9_-]+)/);

  if (tokenMatch && tokenMatch[1]) {
    return tokenMatch[1];
  }

  throw new Error(
    `Could not extract token from email with subject: "${email.subject}"`
  );
}

/**
 * Delete all emails from MailDev
 * Useful for cleaning up between tests
 */
export async function deleteAllEmails(): Promise<void> {
  const url = await getMailDevUrl();
  const response = await fetchMailDev(`${url}/email/all`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`Failed to delete all emails: ${response.statusText}`);
  }
}

/**
 * Delete a specific email by ID
 * @param emailId - The ID of the email to delete
 */
export async function deleteEmail(emailId: string): Promise<void> {
  const url = await getMailDevUrl();
  const response = await fetchMailDev(`${url}/email/${emailId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(
      `Failed to delete email ${emailId}: ${response.statusText}`
    );
  }
}

/**
 * Result of extracting magic link parameters from an email
 */
export interface MagicLinkParams {
  /** The verification code from the magic link URL */
  verificationCode: string;
  /** The state parameter from the magic link URL */
  state: string;
  /** The full magic link URL */
  fullUrl: string;
}

/**
 * Extract magic link parameters from an email body
 * Looks for URLs containing verification_code and state parameters
 * @param email - The email message to extract magic link from
 * @returns The extracted magic link parameters
 * @throws Error if no magic link found
 */
export function extractMagicLinkFromEmail(
  email: MailDevEmail
): MagicLinkParams {
  // Try to extract from HTML first (more reliable formatting)
  const content = email.html || email.text;

  // Pattern: Match a URL containing verification_code and state parameters
  // URLs in HTML are typically in href="..." attributes
  const urlPattern = /https?:\/\/[^\s"'<>]+verification_code=[^\s"'<>]+/gi;
  const urlMatches = content.match(urlPattern);

  if (!urlMatches || urlMatches.length === 0) {
    throw new Error(
      `Could not find magic link URL in email with subject: "${email.subject}"`
    );
  }

  // Use the first matching URL
  const fullUrl = urlMatches[0];

  // Extract verification_code parameter
  const codeMatch = fullUrl.match(/[?&]verification_code=([A-Za-z0-9_-]+)/);
  if (!codeMatch || !codeMatch[1]) {
    throw new Error(
      `Could not extract verification_code from magic link: ${fullUrl}`
    );
  }

  // Extract state parameter
  const stateMatch = fullUrl.match(/[?&]state=([A-Za-z0-9_-]+)/);
  if (!stateMatch || !stateMatch[1]) {
    throw new Error(`Could not extract state from magic link: ${fullUrl}`);
  }

  return {
    verificationCode: codeMatch[1],
    state: stateMatch[1],
    fullUrl,
  };
}
