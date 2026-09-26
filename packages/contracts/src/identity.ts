import { DomainError, text } from './index.js';

export interface IdentityUser {
  id: string;
  name: string;
  email: string;
}
export interface Principal {
  user: IdentityUser;
  spaceId: string;
}
export interface Space {
  id: string;
  name: string;
  kind: 'personal' | 'team';
  role: 'owner' | 'admin' | 'member';
}
export type ProjectRole = 'view' | 'edit' | 'manage';
export interface SpaceMember extends IdentityUser {
  role: Space['role'];
}
export interface IdentityState {
  mode: 'local-preview' | 'team-local';
  setupRequired: boolean;
  user: IdentityUser | null;
  spaces: Space[];
}
export function emailAddress(value: unknown): string {
  const email = text(value, '邮箱', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new DomainError('INVALID_EMAIL', '请输入有效邮箱');
  return email;
}
export function secretText(value: unknown, label: string, min = 12): string {
  if (typeof value !== 'string' || value.length < min || value.length > 128)
    throw new DomainError('INVALID_SECRET', `${label}需要 ${min}–128 个字符`);
  return value; // Passwords must never be trimmed.
}
