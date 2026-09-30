/** Preserve a UTF-8 prefix without splitting a code point or inventing an ellipsis. */
export function boundedBranchOutput(parts: readonly string[], maxBytes = 24 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('Output byte limit must be a non-negative safe integer');
  const encoder = new TextEncoder();
  const full = parts.join('\n\n');
  const totalBytes = encoder.encode(full).byteLength;
  let text = '';
  let retainedBytes = 0;
  for (const character of full) {
    const bytes = encoder.encode(character).byteLength;
    if (retainedBytes + bytes > maxBytes) break;
    text += character;
    retainedBytes += bytes;
  }
  return { text, totalBytes, retainedBytes, truncated: retainedBytes < totalBytes };
}
