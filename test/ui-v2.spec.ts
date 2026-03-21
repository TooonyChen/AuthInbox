import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => {
  class WorkerEntrypoint<TEnv> {
    protected env!: TEnv;
  }
  return { WorkerEntrypoint };
});

import { inferCategoryFromFields, parseSearchTokens } from '../src/index';

describe('gmail-like query helpers', () => {
  it('parses Gmail operators and free text', () => {
    const tokens = parseSearchTokens('from:noreply@example.com subject:"security code" is:unread has:attachment category:promotions token');

    expect(tokens.from).toEqual(['noreply@example.com']);
    expect(tokens.subject).toEqual(['security code']);
    expect(tokens.isFlags).toContain('unread');
    expect(tokens.hasFlags).toContain('attachment');
    expect(tokens.categories).toEqual(['promotions']);
    expect(tokens.text).toContain('token');
  });

  it('infers social and updates categories from metadata', () => {
    expect(inferCategoryFromFields('notifications@facebookmail.com', 'New follower alert')).toBe('social');
    expect(inferCategoryFromFields('billing@service.com', 'Your payment receipt')).toBe('updates');
  });
});
