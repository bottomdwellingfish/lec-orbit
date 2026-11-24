const RESERVED_HOSTED_SLUGS = new Set([
  'admin', 'api', 'assets', 'auth', 'blog', 'blogs', 'callback', 'explore',
  'healthz', 'login', 'logout', 'me', 'new', 'post', 'posts', 'public',
  'rss', 'settings', 'static', 'swagger-ui', 'u', 'v3', 'write',
]);

/** External pages may only be opened at absolute HTTP(S) URLs without inline credentials. */
export function parseBlogUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

/** Validates an optional hosted blog slug against lec-blog backend rules; returns an error message or null when valid. */
export function validateHostedSlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  if (!slug) return null;
  if (slug.length < 2 || slug.length > 32 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_HOSTED_SLUGS.has(slug)) {
    return '博客短链须为 2–32 位小写字母、数字或单个连字符，且不能使用保留字。';
  }
  return null;
}

/** Derives a safe absolute `/write` URL for the hosted Markdown studio from public config or a hosted blog URL. */
export function resolveBlogWriteUrl(publicUrl: unknown, fallbackHostedBlogUrl?: unknown): URL | null {
  const base = parseBlogUrl(publicUrl);
  if (base) {
    const cleanPath = base.pathname.replace(/\/+$/, '');
    return parseBlogUrl(`${base.origin}${cleanPath}/write`);
  }
  const hosted = parseBlogUrl(fallbackHostedBlogUrl);
  if (hosted && /^\/u\/[^/]+/.test(hosted.pathname)) {
    return parseBlogUrl(`${hosted.origin}/write`);
  }
  return null;
}
