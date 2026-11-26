/** 成员博客站点 Logo（优先加载其博客网站 favicon，失败或非 http(s) 地址时回退为内置博客图标）。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Globe } from 'lucide-react';
import { parseBlogUrl } from '@shared/blogUrl';

interface BlogSiteLogoProps {
  blogUrl?: string | null;
  size?: number;
  className?: string;
}

export function BlogSiteLogo({ blogUrl, size = 14, className }: BlogSiteLogoProps): JSX.Element {
  const faviconUrl = useMemo(() => {
    const parsed = parseBlogUrl(blogUrl);
    if (!parsed) return null;
    return `${parsed.origin}/favicon.ico`;
  }, [blogUrl]);

  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [faviconUrl]);

  if (!faviconUrl || failed) {
    return <Globe size={size} className={className} aria-hidden="true" />;
  }

  return (
    <img
      src={faviconUrl}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.25)),
        objectFit: 'contain',
        flexShrink: 0,
        display: 'block',
      }}
      onError={() => setFailed(true)}
    />
  );
}
