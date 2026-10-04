import { describe, expect, it } from 'vitest';
import { auditCategory } from '../src/lib/audit';

describe('auditCategory: role entries', () => {
  it('files per-member role grants/removals (role.add / role.remove) under roles, like role syncs', () => {
    expect(auditCategory('role.add')).toBe('roles');
    expect(auditCategory('role.remove')).toBe('roles');
    expect(auditCategory('roles.sync')).toBe('roles');
    expect(auditCategory('discord.roles')).toBe('roles');
  });

  it('does not over-match other prefixes', () => {
    expect(auditCategory('discord.role.deleted')).toBe('discord');
    expect(auditCategory('roleplay.x')).toBe('system');
  });
});
