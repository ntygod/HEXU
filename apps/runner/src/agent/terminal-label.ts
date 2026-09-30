/** Shared/user-controlled labels must not become terminal commands or conceal
 * the following consent scope. Callers add their own intentional line breaks. */
export const terminalLabel = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
