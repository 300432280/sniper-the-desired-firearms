// backend/scripts/probe/shared/__test__/url-utils.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, isLikelyNavUrl, stripTrailingSlash, preserveFragment } from '../url-utils';

describe('canonicalizeUrl', () => {
  it('lowercases scheme + host, preserves path case + query + fragment', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Product/Foo?a=1#bar'))
      .toBe('https://example.com/Product/Foo?a=1#bar');
  });
  it('adds https when scheme missing', () => {
    expect(canonicalizeUrl('example.com')).toBe('https://example.com/');
  });
  it('rejects malformed', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow();
  });
});

describe('isLikelyNavUrl', () => {
  it('flags wishlist/cart/checkout/account/login as nav', () => {
    for (const path of ['/wishlist', '/cart', '/checkout', '/account', '/login', '/register']) {
      expect(isLikelyNavUrl(`https://example.com${path}`)).toBe(true);
    }
  });
  it('flags about/faq/privacy/terms/blog as nav', () => {
    for (const path of ['/about', '/faq', '/privacy', '/terms', '/blog/post-1']) {
      expect(isLikelyNavUrl(`https://example.com${path}`)).toBe(true);
    }
  });
  it('does NOT flag product/category URLs', () => {
    for (const url of [
      'https://example.com/product/awesome-rifle',
      'https://example.com/firearms/rifles',
      'https://example.com/product-category/handguns',
    ]) {
      expect(isLikelyNavUrl(url)).toBe(false);
    }
  });
});

describe('stripTrailingSlash', () => {
  it('strips trailing slash from non-root', () => {
    expect(stripTrailingSlash('https://example.com/foo/')).toBe('https://example.com/foo');
  });
  it('keeps trailing slash on root', () => {
    expect(stripTrailingSlash('https://example.com/')).toBe('https://example.com/');
  });
});

describe('preserveFragment', () => {
  it('preserves #fragment when adding query params (Searchspring case)', () => {
    const u = new URL('https://example.com/cat#/sort:created_at:desc');
    u.searchParams.set('page', '3');
    expect(preserveFragment(u.toString())).toBe('https://example.com/cat?page=3#/sort:created_at:desc');
  });
});
