/**
 * 公告富文本 HTML 清洗与纯文本提取工具（等价替代 Go 版 bluemonday）。
 */
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'a',
  'img',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

export function sanitizeAnnouncementHtml(rawHtml: string): {
  safeHtml: string;
  plainText: string;
} {
  const safeHtml = sanitizeHtml(rawHtml ?? '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      code: ['class'],
      pre: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  }).trim();

  const plainText = sanitizeHtml(safeHtml, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();

  return { safeHtml, plainText };
}
