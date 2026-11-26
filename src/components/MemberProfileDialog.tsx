/** 工作室成员个人信息卡弹窗：聚合 LecSSO 公开资料、第三方绑定（GitHub / 飞书）、在岗状态与本周考勤排名。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Avatar, Button, Dialog, Tag } from '@lec-space/liquidglass';
import { ArrowUpRight, Check, Clock, Copy, Flame, Settings, Trophy } from 'lucide-react';
import type { StudioMemberCard } from '@shared/ipc';
import {
  formatReadableDuration,
  type MemberTitleBadge,
  type TeamActiveMember,
  type TeamWeeklyRankingItem,
} from '@shared/punch';
import { BlogSiteLogo } from '@/components/BlogSiteLogo';
import { SocialBrandGlyph } from '@/components/SocialBrandGlyph';
import { TitleBadgeList } from '@/components/TitleBadge';
import { getOrbitClient } from '@/services/orbitClient';
import { notifyToast } from '@/services/orbitToast';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './MemberProfileDialog.module.css';

/** 可从成员名录、本周排行榜或今日在岗伙伴任一卡片传入的定位种子。 */
export interface MemberProfileSeed {
  id?: string;
  username?: string | null;
  displayName?: string;
  realName?: string;
  nickname?: string;
  avatar?: string | null;
  teamName?: string;
  titles?: MemberTitleBadge[];
  studioMember?: StudioMemberCard;
  ranking?: TeamWeeklyRankingItem;
  active?: TeamActiveMember;
}

const ROLE_LABELS: Record<string, { label: string; tone: 'info' | 'warning' | 'neutral' }> = {
  captain: { label: '工作室队长', tone: 'info' },
  'lec-captain': { label: '工作室队长', tone: 'info' },
  admin: { label: '管理员', tone: 'info' },
  'senior-captain': { label: '往届队长', tone: 'warning' },
  member: { label: '正式成员', tone: 'neutral' },
};

/** 从角色列表中提炼展示优先级最高的角色徽章。 */
export function resolvePrimaryStudioRole(roles: readonly string[]): {
  label: string;
  tone: 'info' | 'warning' | 'neutral';
} {
  const lowered = roles.map((r) => r.toLowerCase());
  for (const key of ['captain', 'lec-captain', 'admin', 'senior-captain', 'member']) {
    if (lowered.includes(key)) {
      return ROLE_LABELS[key]!;
    }
  }
  return { label: '工作室成员', tone: 'neutral' };
}

/** 根据 username（优先）或真名匹配 LecSSO 成员名片与 LecPunch 数据。 */
export function matchStudioMember(
  seed: MemberProfileSeed,
  members: readonly StudioMemberCard[],
): StudioMemberCard | undefined {
  if (seed.studioMember) return seed.studioMember;
  const targetHandle = seed.username?.trim().toLowerCase();
  if (targetHandle) {
    const byHandle = members.find((m) => m.username?.toLowerCase() === targetHandle);
    if (byHandle) return byHandle;
  }
  if (seed.id) {
    const byId = members.find((m) => m.id === seed.id);
    if (byId) return byId;
  }
  const targetName = (seed.realName || seed.displayName || '').trim();
  if (targetName) {
    const exact = members.find((m) => m.name && m.name.trim() === targetName);
    if (exact) return exact;
    const stripped = targetName.replace(/[（(].*[）)]$/, '').trim();
    if (stripped) {
      return members.find((m) => m.name && m.name.trim() === stripped);
    }
  }
  return undefined;
}

function matchByMember<T extends { username?: string; realName?: string; displayName: string }>(
  member: StudioMemberCard | undefined,
  seed: MemberProfileSeed,
  list: readonly T[],
): T | undefined {
  const targetHandle = (member?.username || seed.username || '').trim().toLowerCase();
  if (targetHandle) {
    const byHandle = list.find((item) => item.username?.trim().toLowerCase() === targetHandle);
    if (byHandle) return byHandle;
  }
  const targetName = (member?.name || seed.realName || '').trim();
  if (targetName) {
    const byRealName = list.find(
      (item) =>
        item.realName?.trim() === targetName ||
        item.displayName.replace(/[（(].*[）)]$/, '').trim() === targetName,
    );
    if (byRealName) return byRealName;
  }
  return undefined;
}

function SmallSocialAvatar({
  avatar,
  target,
  alt,
}: {
  avatar: string | null;
  target: 'github' | 'feishu';
  alt: string;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);

  if (avatar && !failed) {
    return (
      <span className={styles.socialAvatarWrap}>
        <img
          src={avatar}
          alt={alt}
          className={styles.socialAvatarImg}
          onError={() => setFailed(true)}
        />
        <span className={styles.socialCorner} aria-hidden="true">
          <SocialBrandGlyph target={target} size={11} />
        </span>
      </span>
    );
  }
  return (
    <span className={styles.socialIconCircle} aria-hidden="true">
      <SocialBrandGlyph target={target} size={18} />
    </span>
  );
}

export interface MemberProfileDialogProps {
  seed: MemberProfileSeed | null;
  onClose: () => void;
}

export function MemberProfileDialog({ seed, onClose }: MemberProfileDialogProps): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const studioMembers = useOrbitStore((s) => s.studioMembers);
  const studioMembersLoading = useOrbitStore((s) => s.studioMembersLoading);
  const studioMembersError = useOrbitStore((s) => s.studioMembersError);
  const teamRanking = useOrbitStore((s) => s.teamRanking);
  const teamActive = useOrbitStore((s) => s.teamActive);
  const memberBlogs = useOrbitStore((s) => s.memberBlogs);
  const openBlogTarget = useOrbitStore((s) => s.openBlogTarget);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const refreshStudioMembers = useOrbitStore((s) => s.refreshStudioMembers);
  const [copiedHandle, setCopiedHandle] = useState(false);

  // 打开名片时若尚未拉取过工作室成员目录，自动补拉一次以展示 GitHub / 飞书信息
  useEffect(() => {
    if (
      seed &&
      auth.authenticated &&
      studioMembers.length === 0 &&
      !studioMembersLoading &&
      !studioMembersError
    ) {
      void refreshStudioMembers();
    }
  }, [
    seed,
    auth.authenticated,
    studioMembers.length,
    studioMembersLoading,
    studioMembersError,
    refreshStudioMembers,
  ]);

  const resolved = useMemo(() => {
    if (!seed) return null;
    const member = matchStudioMember(seed, studioMembers);
    const ranking = seed.ranking ?? matchByMember(member, seed, teamRanking);
    const active = seed.active ?? matchByMember(member, seed, teamActive);

    const handle = member?.username ?? seed.username ?? ranking?.username ?? active?.username ?? null;
    const realName = member?.name ?? seed.realName ?? ranking?.realName ?? active?.realName ?? null;
    const displayName =
      seed.displayName ||
      ranking?.displayName ||
      active?.displayName ||
      realName ||
      handle ||
      '工作室成员';
    const avatar = member?.avatar ?? seed.avatar ?? ranking?.avatar ?? active?.avatar ?? undefined;
    const enrollYearLabel = member?.enrollYear
      ? `${member.enrollYear} 级`
      : seed.teamName || ranking?.teamName || active?.teamName || null;
    const role = resolvePrimaryStudioRole(member?.roles ?? []);
    const titles = seed.titles ?? active?.titles ?? ranking?.titles ?? [];
    const isSelf = Boolean(
      (member?.id && auth.profile?.subject && member.id === auth.profile.subject) ||
        (handle &&
          auth.profile?.username &&
          handle.toLowerCase() === auth.profile.username.toLowerCase()),
    );

    return {
      member,
      ranking,
      active,
      handle,
      realName,
      displayName,
      avatar,
      enrollYearLabel,
      role,
      titles,
      isSelf,
    };
  }, [seed, studioMembers, teamRanking, teamActive, auth.profile]);

  const handleCopyHandle = async (value: string) => {
    await getOrbitClient().system.copyText(value);
    setCopiedHandle(true);
    notifyToast({ tone: 'success', title: '已复制 Handle', description: value });
    window.setTimeout(() => setCopiedHandle(false), 1800);
  };

  const github = resolved?.member?.social.github ?? null;
  const feishu = resolved?.member?.social.feishu ?? null;
  const memberBlog = useMemo(() => {
    if (!resolved) return null;
    if (resolved.member?.id) {
      const byId = memberBlogs.find((b) => b.userId === resolved.member!.id);
      if (byId) return byId;
    }
    if (resolved.handle) {
      const lower = resolved.handle.toLowerCase();
      const byHandle = memberBlogs.find((b) => b.username?.toLowerCase() === lower);
      if (byHandle) return byHandle;
    }
    return null;
  }, [resolved, memberBlogs]);
  const githubLabel = github
    ? github.username
      ? github.name && github.name !== github.username
        ? `${github.name}（@${github.username}）`
        : `@${github.username}`
      : github.name || '已绑定 GitHub'
    : null;
  const feishuLabel = feishu
    ? [feishu.name, feishu.enName]
        .filter((v, idx, arr): v is string => Boolean(v) && arr.indexOf(v) === idx)
        .join(' · ') || '已绑定飞书'
    : null;

  return (
    <Dialog
      open={Boolean(seed && resolved)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="成员名片"
      description={resolved?.isSelf ? '你在 LEC 软件工作室的公开名片预览' : 'LEC 软件工作室成员公开资料'}
      footer={
        resolved ? (
          <div className={styles.footerRow}>
            {resolved.isSelf && (
              <Button
                variant="glass"
                size="small"
                icon={<Settings size={14} />}
                onClick={() => {
                  onClose();
                  setActiveTab('settings');
                }}
              >
                去设置页管理绑定
              </Button>
            )}
            <Button variant="filled" size="small" onClick={onClose}>
              关闭
            </Button>
          </div>
        ) : undefined
      }
    >
      {resolved && (
        <div className={styles.body}>
          <div className={styles.hero}>
            <div className={styles.heroAvatarWrap}>
              <Avatar src={resolved.avatar} name={resolved.realName || resolved.displayName} size="large" />
              {resolved.active && <span className={styles.onlineDot} title="此刻正在工作室专注中" />}
            </div>
            <div className={styles.heroInfo}>
              <div className={styles.nameRow}>
                <h3 className={styles.name}>{resolved.displayName}</h3>
                <Tag tone={resolved.role.tone}>{resolved.role.label}</Tag>
                {resolved.enrollYearLabel && <Tag tone="neutral">{resolved.enrollYearLabel}</Tag>}
              </div>

              {resolved.handle && (
                <button
                  type="button"
                  className={styles.handleChip}
                  onClick={() => void handleCopyHandle(resolved.handle!)}
                  title="点击复制 LecSSO Handle"
                >
                  <span>@{resolved.handle}</span>
                  {copiedHandle ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}

              {resolved.titles.length > 0 && (
                <div className={styles.titlesRow}>
                  <TitleBadgeList titles={resolved.titles} size="xs" maxVisible={4} />
                </div>
              )}
            </div>
          </div>

          <div className={styles.statsGrid}>
            <div className={styles.statBox}>
              <div className={styles.statLabel}>
                <Flame size={13} /> 当前状态
              </div>
              {resolved.active ? (
                <>
                  <div className={styles.statValueActive}>工作室专注中</div>
                  <div className={styles.statSub}>
                    {typeof resolved.active.durationSeconds === 'number'
                      ? `已专注 ${formatReadableDuration(resolved.active.durationSeconds)}`
                      : `签到于 ${new Date(resolved.active.checkedInAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}`}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.statValueMuted}>暂未打卡</div>
                  <div className={styles.statSub}>当前不在工作室计时中</div>
                </>
              )}
            </div>

            <div className={styles.statBox}>
              <div className={styles.statLabel}>
                <Trophy size={13} /> 本周专注
              </div>
              {resolved.ranking ? (
                <>
                  <div className={styles.statValue}>
                    {formatReadableDuration(resolved.ranking.totalDurationSeconds)}
                  </div>
                  <div className={styles.statSub}>
                    {typeof resolved.ranking.rank === 'number'
                      ? `本周第 ${resolved.ranking.rank} 名`
                      : '本周已上榜'}
                    {resolved.ranking.qualified ? ' · 已达标' : ''}
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.statValueMuted}>暂无记录</div>
                  <div className={styles.statSub}>本周尚未产生专注统计</div>
                </>
              )}
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              <Clock size={13} /> 关联社交名片
            </div>

            <div className={styles.socialCards}>
              <div className={styles.socialItem}>
                <div className={styles.socialLeft}>
                  <SmallSocialAvatar
                    avatar={github?.avatar ?? null}
                    target="github"
                    alt="GitHub"
                  />
                  <div className={styles.socialText}>
                    <div className={styles.socialHead}>
                      <span className={styles.socialName}>GitHub</span>
                      <Tag tone={github ? 'success' : 'neutral'}>
                        {github ? '已绑定' : '未绑定'}
                      </Tag>
                    </div>
                    <div className={styles.socialDesc}>
                      {github ? githubLabel : '对方尚未绑定 GitHub 账号'}
                    </div>
                  </div>
                </div>
                {github?.profileUrl && (
                  <Button
                    variant="glass"
                    size="small"
                    icon={<ArrowUpRight size={13} />}
                    onClick={() => void getOrbitClient().system.openExternal(github.profileUrl!)}
                  >
                    访问主页
                  </Button>
                )}
              </div>

              <div className={styles.socialItem}>
                <div className={styles.socialLeft}>
                  <SmallSocialAvatar
                    avatar={feishu?.avatar ?? null}
                    target="feishu"
                    alt="飞书"
                  />
                  <div className={styles.socialText}>
                    <div className={styles.socialHead}>
                      <span className={styles.socialName}>飞书</span>
                      <Tag tone={feishu ? 'success' : 'neutral'}>
                        {feishu ? '已绑定' : '未绑定'}
                      </Tag>
                    </div>
                    <div className={styles.socialDesc}>
                      {feishu ? `${feishuLabel} · 乐程软件工作室` : '对方尚未绑定工作室飞书'}
                    </div>
                  </div>
                </div>
              </div>

              {memberBlog && (
                <div className={styles.socialItem}>
                  <div className={styles.socialLeft}>
                    <span className={styles.socialIconCircle} aria-hidden="true">
                      <BlogSiteLogo blogUrl={memberBlog.blogUrl} size={18} />
                    </span>
                    <div className={styles.socialText}>
                      <div className={styles.socialHead}>
                        <span className={styles.socialName}>个人博客</span>
                        <Tag tone="info">已开通</Tag>
                      </div>
                      <div className={styles.socialDesc}>
                        {memberBlog.blogTitle || memberBlog.blogUrl}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="glass"
                    size="small"
                    icon={<ArrowUpRight size={13} />}
                    onClick={() => {
                      openBlogTarget(memberBlog.userId, memberBlog.blogUrl);
                      onClose();
                      setActiveTab('blogs');
                    }}
                  >
                    阅读博客
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
