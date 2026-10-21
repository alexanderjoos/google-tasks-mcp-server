/**
 * Which linked Google account each API uses.
 *
 * One connection can link several allowlisted accounts (e.g. a school and a personal one).
 * Tasks can't be shared between accounts, so Tasks always uses one account. Sheets and Docs
 * try the accounts in allowlist order, falling back when an account can't see the file.
 */
import type { UserProps } from "./env.js";

/** Linked accounts as email → refresh token. Grants from before multi-account have one account. */
export function linkedAccounts(props: UserProps | undefined): Record<string, string> {
  if (props?.accounts) return props.accounts;
  if (props?.email && props.googleRefreshToken) return { [props.email.toLowerCase()]: props.googleRefreshToken };
  return {};
}

/**
 * Accounts for files (in allowlist order) and the one account for Tasks. Accounts no longer on
 * the allowlist are dropped, so removing an email from ALLOWED_EMAIL cuts its access right away.
 */
export function resolveAccounts(
  linked: Record<string, string>,
  allowed: string[],
  tasksAccount: string | undefined,
): { files: string[]; tasks: string | undefined } {
  const files = allowed.filter((email) => email in linked);
  const preferred = tasksAccount?.trim().toLowerCase();
  return { files, tasks: preferred && files.includes(preferred) ? preferred : files[0] };
}
