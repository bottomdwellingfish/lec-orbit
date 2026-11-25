/**
 * Devtron 发版通知元信息提取与贡献者归属工具（等价迁移原 Go devtron_release.go）。
 */

export interface ReleaseCommitItem {
  sha: string;
  shortSha: string;
  message: string;
  author?: string;
  authorLogin?: string;
  authorAvatar?: string;
  committedAt?: string;
  url?: string;
}

export interface ReleaseContributor {
  githubLogin?: string;
  name?: string;
  avatar?: string;
  roleLabel?: string;
  commits?: number;
}

export interface ReleaseMeta {
  appName: string;
  displayName?: string;
  environment?: string;
  version?: string;
  dockerImage?: string;
  gitHash?: string;
  shortSha?: string;
  branch?: string;
  repo?: string;
  commitTitle?: string;
  commitBody?: string;
  author?: string;
  authorLogin?: string;
  authorAvatar?: string;
  proposer?: ReleaseContributor;
  triggeredBy?: string;
  appUrl?: string;
  commitUrl?: string;
  devtronUrl?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  commits?: ReleaseCommitItem[];
  contributors?: ReleaseContributor[];
}

interface KnownAppSpec {
  displayName: string;
  repo: string;
  appUrl: string;
}

const KNOWN_STUDIO_APPS: Record<string, KnownAppSpec> = {
  'lec-sso': { displayName: 'LecSSO 统一身份', repo: 'lec-org/lec-sso', appUrl: 'https://sso.lecspace.top/portal' },
  lecsso: { displayName: 'LecSSO 统一身份', repo: 'lec-org/lec-sso', appUrl: 'https://sso.lecspace.top/portal' },
  'lec-doc': { displayName: 'LecDoc 乐程云文档', repo: 'lec-org/lec-doc', appUrl: 'https://doc.lecspace.top' },
  lecdoc: { displayName: 'LecDoc 乐程云文档', repo: 'lec-org/lec-doc', appUrl: 'https://doc.lecspace.top' },
  'lecpunch-api': { displayName: 'LecPunch 考勤 API', repo: 'lec-org/LecPunch', appUrl: 'https://punch.lecspace.top' },
  'lecpunch-web': { displayName: 'LecPunch 考勤前端', repo: 'lec-org/LecPunch', appUrl: 'https://punch.lecspace.top' },
  'lec-punch': { displayName: 'LecPunch 考勤打卡', repo: 'lec-org/LecPunch', appUrl: 'https://punch.lecspace.top' },
  'lec-drive': { displayName: 'LecDrive 云盘素材', repo: 'lec-org/lec-drive', appUrl: 'https://drive.lecspace.top' },
  'lec-oj': { displayName: 'LecOJ 在线判题', repo: 'lec-org/lec-oj', appUrl: 'https://code.lecspace.top' },
  'lec-oj-judge': { displayName: 'LecOJ 判题评测机', repo: 'lec-org/lec-oj', appUrl: 'https://code.lecspace.top' },
  'lec-website': { displayName: '乐程工作室官网', repo: 'lec-org/LEC-Official-Website', appUrl: 'https://lecspace.top' },
  'lec-orbit': { displayName: 'Orbit 伴程', repo: 'lec-org/lec-orbit', appUrl: 'https://lec-org.github.io/lec-orbit/' },
  'lec-orbit-server': { displayName: 'Orbit 服务端', repo: 'lec-org/lec-orbit', appUrl: 'https://lec-org.github.io/lec-orbit/' },
  orbit: { displayName: 'Orbit 伴程', repo: 'lec-org/lec-orbit', appUrl: 'https://lec-org.github.io/lec-orbit/' },
  'lec-blog': { displayName: '乐程博客', repo: 'lec-org/lec-blog', appUrl: '' },
};

const VERSION_SHA_REGEX = /^([0-9a-fA-F]{7,40})(?:[-_].*)?$/;
const CO_AUTHOR_REGEX = /^co-authored-by:\s*([^<\r\n]+?)(?:\s*<([^>\r\n]+)>)?\s*$/gim;
const GITHUB_NOREPLY_REGEX = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;

function firstNonEmptyString(
  sources: Array<Record<string, unknown> | undefined>,
  ...keys: string[]
): string {
  for (const src of sources) {
    if (!src) continue;
    for (const k of keys) {
      const val = src[k];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }
  }
  return '';
}

export function extractShaFromVersion(version: string): string {
  let trimmed = version.trim();
  if (!trimmed) return '';
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx >= 0 && colonIdx + 1 < trimmed.length) {
    trimmed = trimmed.slice(colonIdx + 1);
  }
  const m = VERSION_SHA_REGEX.exec(trimmed);
  return m?.[1] ? m[1].toLowerCase() : '';
}

export function splitCommitMessage(msg: string): { title: string; body: string } {
  const normalized = msg.trim().replace(/\r\n/g, '\n');
  if (!normalized) return { title: '', body: '' };
  const idx = normalized.indexOf('\n');
  if (idx < 0) return { title: normalized, body: '' };
  return {
    title: normalized.slice(0, idx).trim(),
    body: normalized.slice(idx + 1).trim(),
  };
}

function aggregateContributors(meta: ReleaseMeta): ReleaseContributor[] {
  const index = new Map<string, number>();
  const out: ReleaseContributor[] = [];

  const add = (login: string, name: string, avatar: string) => {
    const cleanLogin = login.trim();
    const cleanName = name.trim();
    const key = (cleanLogin || cleanName).toLowerCase();
    if (!key) return;
    const pos = index.get(key);
    if (pos !== undefined) {
      out[pos].commits = (out[pos].commits ?? 0) + 1;
      if (!out[pos].githubLogin && cleanLogin) out[pos].githubLogin = cleanLogin;
      if (!out[pos].name && cleanName) out[pos].name = cleanName;
      if (!out[pos].avatar && avatar) out[pos].avatar = avatar;
      return;
    }
    index.set(key, out.length);
    out.push({
      githubLogin: cleanLogin || undefined,
      name: cleanName || undefined,
      avatar: avatar || undefined,
      commits: 1,
    });
  };

  const extractCoAuthors = (text: string) => {
    CO_AUTHOR_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CO_AUTHOR_REGEX.exec(text)) !== null) {
      const coName = (match[1] ?? '').trim();
      let coLogin = '';
      if (match[2]) {
        const gh = GITHUB_NOREPLY_REGEX.exec(match[2].trim());
        if (gh?.[1]) coLogin = gh[1].trim();
      }
      add(coLogin, coName, '');
    }
  };

  for (const c of meta.commits ?? []) {
    add(c.authorLogin ?? '', c.author ?? '', c.authorAvatar ?? '');
    extractCoAuthors(c.message);
  }
  if (out.length === 0) {
    add(meta.authorLogin ?? '', meta.author ?? '', meta.authorAvatar ?? '');
    extractCoAuthors(meta.commitBody ?? '');
  }
  return out;
}

async function enrichFromGitHub(meta: ReleaseMeta, token: string): Promise<void> {
  if (!meta.repo || !meta.gitHash || !token) return;
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${meta.repo}/commits/${meta.gitHash}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'lec-orbit-server',
        },
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!resp.ok) return;
    const gh = (await resp.json()) as {
      sha?: string;
      html_url?: string;
      commit?: { message?: string; author?: { name?: string; date?: string } };
      author?: { login?: string; avatar_url?: string };
      stats?: { additions?: number; deletions?: number };
      files?: Array<{ filename?: string }>;
    };
    if (gh.sha) {
      meta.gitHash = gh.sha;
      meta.shortSha = gh.sha.slice(0, 8);
    }
    if (gh.html_url) meta.commitUrl = gh.html_url;
    const { title, body } = splitCommitMessage(gh.commit?.message ?? '');
    meta.commitTitle = title || undefined;
    meta.commitBody = body || undefined;
    if (gh.author?.login) {
      meta.authorLogin = gh.author.login;
      meta.authorAvatar = gh.author.avatar_url;
    }
    meta.author = gh.commit?.author?.name || gh.author?.login || meta.author;
    meta.filesChanged = gh.files?.length ?? 0;
    meta.additions = gh.stats?.additions ?? 0;
    meta.deletions = gh.stats?.deletions ?? 0;
    if (title && (!meta.commits || meta.commits.length === 0)) {
      meta.commits = [
        {
          sha: meta.gitHash ?? '',
          shortSha: meta.shortSha ?? '',
          message: gh.commit?.message ?? '',
          author: meta.author,
          authorLogin: meta.authorLogin,
          authorAvatar: meta.authorAvatar,
          committedAt: gh.commit?.author?.date,
          url: meta.commitUrl,
        },
      ];
    }
  } catch {
    // 忽略 GitHub 超时或网络失败
  }
}

export async function buildReleaseMeta(
  raw: Record<string, unknown>,
  githubToken = '',
): Promise<{ meta: ReleaseMeta; summary: string }> {
  const nested =
    raw.payload && typeof raw.payload === 'object'
      ? (raw.payload as Record<string, unknown>)
      : undefined;
  const sources = [raw, nested];

  const appName = firstNonEmptyString(sources, 'appName', 'app_name', 'application') || 'studio-app';
  const spec = KNOWN_STUDIO_APPS[appName.toLowerCase()];

  let version = firstNonEmptyString(sources, 'version', 'imageTag', 'tag');
  const dockerImage = firstNonEmptyString(sources, 'dockerImage', 'dockerImageUrl', 'image');
  if (!version && dockerImage) {
    const idx = dockerImage.lastIndexOf(':');
    if (idx >= 0 && idx + 1 < dockerImage.length) {
      version = dockerImage.slice(idx + 1);
    }
  }

  const gitHash =
    firstNonEmptyString(sources, 'gitHash', 'commitHash', 'commitSha', 'sha') ||
    extractShaFromVersion(version);
  const shortSha = gitHash.slice(0, 8);
  const repo = firstNonEmptyString(sources, 'repo', 'repository') || spec?.repo || '';
  const appUrl = firstNonEmptyString(sources, 'appUrl', 'appURL', 'url') || spec?.appUrl || '';
  const devtronUrl =
    firstNonEmptyString(sources, 'devtronUrl', 'devtronURL', 'appDetailLink', 'cdPipelineLink') ||
    'https://devtron.lecspace.top/dashboard/app/list';

  const commitMsg = firstNonEmptyString(
    sources,
    'commitMessage',
    'commit_message',
    'changelog',
    'releaseNotes',
  );
  const { title: commitTitle, body: commitBody } = splitCommitMessage(commitMsg);

  const meta: ReleaseMeta = {
    appName,
    displayName: spec?.displayName,
    environment: firstNonEmptyString(sources, 'envName', 'environment', 'env') || '校园生产环境',
    version: version || undefined,
    dockerImage: dockerImage || undefined,
    gitHash: gitHash || undefined,
    shortSha: shortSha || undefined,
    branch: firstNonEmptyString(sources, 'branch', 'gitBranch') || undefined,
    repo: repo || undefined,
    commitTitle: commitTitle || undefined,
    commitBody: commitBody || undefined,
    author: firstNonEmptyString(sources, 'author', 'commitAuthor', 'committer') || undefined,
    authorLogin:
      firstNonEmptyString(sources, 'authorLogin', 'githubLogin', 'author_login') || undefined,
    authorAvatar: firstNonEmptyString(sources, 'authorAvatar', 'author_avatar') || undefined,
    triggeredBy: firstNonEmptyString(sources, 'triggeredBy', 'triggered_by') || undefined,
    appUrl: appUrl || undefined,
    devtronUrl,
    commitUrl: repo && gitHash ? `https://github.com/${repo}/commit/${gitHash}` : undefined,
  };

  const proposerName = firstNonEmptyString(sources, 'proposer', 'requestedBy', 'requested_by');
  if (proposerName) {
    meta.proposer = {
      githubLogin: firstNonEmptyString(sources, 'proposerLogin', 'requestedByLogin') || undefined,
      name: proposerName,
      roleLabel: '需求提出',
    };
  }

  if (Array.isArray(raw.commits)) {
    const commits: ReleaseCommitItem[] = [];
    for (const item of raw.commits) {
      if (!item || typeof item !== 'object') continue;
      const m = item as Record<string, unknown>;
      const sha = firstNonEmptyString([m], 'sha', 'id', 'hash');
      const msg = firstNonEmptyString([m], 'message', 'title');
      if (!sha && !msg) continue;
      commits.push({
        sha,
        shortSha: sha.slice(0, 8),
        message: msg,
        author: firstNonEmptyString([m], 'author', 'authorName') || undefined,
        authorLogin: firstNonEmptyString([m], 'authorLogin', 'githubLogin', 'login') || undefined,
        authorAvatar: firstNonEmptyString([m], 'authorAvatar', 'avatar') || undefined,
        committedAt: firstNonEmptyString([m], 'committedAt', 'timestamp', 'date') || undefined,
        url:
          firstNonEmptyString([m], 'url') ||
          (repo && sha ? `https://github.com/${repo}/commit/${sha}` : undefined),
      });
    }
    if (commits.length > 0) {
      meta.commits = commits;
      if (!meta.commitTitle) {
        const split = splitCommitMessage(commits[0].message);
        meta.commitTitle = split.title || undefined;
        meta.commitBody = split.body || undefined;
        meta.author = meta.author || commits[0].author;
        meta.authorLogin = meta.authorLogin || commits[0].authorLogin;
      }
    }
  }

  if (!meta.commitTitle && meta.repo && meta.gitHash && githubToken) {
    await enrichFromGitHub(meta, githubToken);
  }

  meta.contributors = aggregateContributors(meta);

  let summary = firstNonEmptyString(sources, 'summary', 'message');
  if (meta.commitTitle) {
    summary = meta.author
      ? `更新内容：${meta.commitTitle}（提交者：${meta.author}）`
      : `更新内容：${meta.commitTitle}`;
  } else if (!summary) {
    summary = meta.version
      ? `${appName} 已完成新一轮${meta.environment}发布（镜像版本 ${meta.version}）。`
      : `${appName} 已完成新一轮${meta.environment}发布上线。`;
  }

  return { meta, summary };
}
