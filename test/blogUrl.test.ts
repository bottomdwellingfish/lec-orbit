import { describe, expect, test } from 'bun:test';
import { parseBlogUrl, resolveBlogWriteUrl, validateHostedSlug } from '../src/shared/blogUrl';

describe('成员博客地址', () => {
  test('接受绝对 HTTP(S) 地址并规范化主机', () => {
    expect(parseBlogUrl(' HTTPS://Example.com/posts/one#notes ')?.href)
      .toBe('https://example.com/posts/one#notes');
    expect(parseBlogUrl('http://example.com:8080/')?.origin).toBe('http://example.com:8080');
  });

  test.each([
    '/article', '//example.com', 'https:example.com', 'https://',
    'file:///blog.html', 'data:text/html,blog', 'javascript:void(0)', 'lec-orbit://blog',
    'https://user:password@example.com',
  ])('拒绝不允许的目标 %s', (value) => {
    expect(parseBlogUrl(value)).toBeNull();
  });
});

describe('托管博客短链校验与写作台地址推导', () => {
  test('允许留空自动生成以及合法短链', () => {
    expect(validateHostedSlug('')).toBeNull();
    expect(validateHostedSlug('   ')).toBeNull();
    expect(validateHostedSlug('alice')).toBeNull();
    expect(validateHostedSlug('Lin-Xiao-01')).toBeNull();
  });

  test.each(['a', 'a--b', '-alice', 'alice-', 'admin', 'write', 'api', 'alice_1', '中文'])(
    '拒绝非法或保留短链 %s',
    (slug) => {
      expect(validateHostedSlug(slug)).not.toBeNull();
    },
  );

  test('优先使用公开配置推导写作台地址并支持回退到托管博客源站', () => {
    expect(resolveBlogWriteUrl('https://blog.lecspace.top/')?.href)
      .toBe('https://blog.lecspace.top/write');
    expect(resolveBlogWriteUrl('https://portal.lecspace.top/blog/')?.href)
      .toBe('https://portal.lecspace.top/blog/write');
    expect(resolveBlogWriteUrl(null, 'https://blog.lecspace.top/u/alice')?.href)
      .toBe('https://blog.lecspace.top/write');
    expect(resolveBlogWriteUrl(null, 'https://external.example.com/posts')?.href)
      .toBeUndefined();
    expect(resolveBlogWriteUrl('javascript:alert(1)', 'file:///u/alice')).toBeNull();
  });
});
