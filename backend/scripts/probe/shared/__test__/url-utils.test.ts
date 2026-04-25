// backend/scripts/probe/shared/__test__/url-utils.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, isLikelyNavUrl, stripTrailingSlash } from '../url-utils';

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
  it('rejects localhost', () => {
    expect(() => canonicalizeUrl('https://localhost/foo')).toThrow(/localhost/);
  });
  it('rejects 127.0.0.1', () => {
    expect(() => canonicalizeUrl('http://127.0.0.1:8080')).toThrow(/127\.0\.0\.1/);
  });
  it('rejects RFC 1918 private ranges (10.x, 172.16-31.x, 192.168.x)', () => {
    expect(() => canonicalizeUrl('http://10.0.0.1/')).toThrow(/private|localhost/i);
    expect(() => canonicalizeUrl('http://192.168.1.1/')).toThrow(/private|localhost/i);
    expect(() => canonicalizeUrl('http://172.16.0.1/')).toThrow(/private|localhost/i);
    expect(() => canonicalizeUrl('http://172.31.255.255/')).toThrow(/private|localhost/i);
    // 172.32.0.0 is NOT private — public IP, should NOT throw
    expect(canonicalizeUrl('http://172.32.0.1/')).toBe('http://172.32.0.1/');
  });
  it('rejects link-local 169.254.x', () => {
    expect(() => canonicalizeUrl('http://169.254.169.254/')).toThrow(/private|localhost/i);
  });
  it('rejects IPv6 loopback', () => {
    expect(() => canonicalizeUrl('http://[::1]/')).toThrow(/private|localhost/i);
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
  it('flags mailto/javascript/tel/anchor fragments as nav', () => {
    expect(isLikelyNavUrl('mailto:foo@bar.com')).toBe(true);
    expect(isLikelyNavUrl('javascript:void(0)')).toBe(true);
    expect(isLikelyNavUrl('tel:555-1234')).toBe(true);
    expect(isLikelyNavUrl('#anchor')).toBe(true);
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
  it('does NOT match nav keywords as substrings within product slugs (false-positive guard)', () => {
    // Real-world false-positive cases — prior regex incorrectly flagged these
    for (const url of [
      'https://example.com/products/about-our-company-shotgun',
      'https://example.com/firearms/news-from-the-range',
      'https://example.com/accessories/cartridge-holder',
      'https://example.com/products/registration-papers-included',
      'https://example.com/category/blog-style-target',
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
