/** Decode the supported Fabric publishable-key response formats. @internal */
export function parsePublishableKeyResponse(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'string') return parsed;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'publishableKey' in parsed &&
      typeof parsed.publishableKey === 'string'
    ) {
      return parsed.publishableKey;
    }
  } catch {
    const key = body.trim();
    if (/^pk[-_][A-Za-z0-9_-]+$/.test(key)) return key;
  }
  return undefined;
}
