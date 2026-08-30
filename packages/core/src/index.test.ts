import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('core package', () => {
  it('exposes a version string', () => {
    expect(VERSION).toBe('0.2.0');
  });
});
