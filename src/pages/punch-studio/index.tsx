/**
 * LecPunch 工作室动态页（高密度双栏总览）：
 * - 同屏并排呈现「本周专注排行榜」与「工作室成员名录」，有近期活动时在右侧顶部紧凑展示；
 * - 列表全部采用轻量面板 + LiteAvatar + content-visibility，杜绝长列表液态玻璃折射卡顿；
 * - 点击任意周榜行或成员卡片均可弹出统一的 MemberProfileDialog 个人名片。
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import {
  Button,
  Empty,
  Input,
  Message,
  SegmentedControl,
} from '@lec-space/liquidglass';
import { CalendarDays, ExternalLink, RefreshCw, Trophy } from '@lec-space/icons';
import { Award, CheckCircle2, ChevronDown, ChevronRight, Radio, Search, Users } from 'lucide-react';
import { getOrbitEndpoints } from '@shared/env';
import type { StudioMemberCard } from '@shared/ipc';
import { formatReadableDuration, type TeamWeeklyRankingItem } from '@shared/punch';
import { BlogSiteLogo } from '@/components/BlogSiteLogo';
import {
  MemberProfileDialog,
  resolvePrimaryStudioRole,
  type MemberProfileSeed,
} from '@/components/MemberProfileDialog';
import { SocialBrandGlyph } from '@/components/SocialBrandGlyph';
import { TitleBadgeList } from '@/components/TitleBadge';
import type { MemberBlogItem } from '@/services/blogApi';
import { getOrbitClient } from '@/services/orbitClient';
import { useOrbitStore } from '@/stores/useOrbitStore';
import styles from './PunchStudio.module.css';

interface GradeGroup {
  key: string;
  label: string;
  members: StudioMemberCard[];
}

/** 列表专用轻量头像（零 useRefraction / 零 backdrop-filter，支持懒加载与异步解码）。 */
function LiteAvatar({
  src,
  name,
  size = 'small',
}: {
  src?: string;
  name: string;
  size?: 'xs' | 'small' | 'regular';
}): JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || '?';
  const showImg = Boolean(src && failedSrc !== src);
  const sizeClass =
    size === 'xs'
      ? styles.liteAvatarXs
      : size === 'regular'
        ? styles.liteAvatarRegular
        : styles.liteAvatarSmall;

  return (
    <span className={`${styles.liteAvatar} ${sizeClass}`} role="img" aria-label={name}>
      {showImg ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          className={styles.liteAvatarImg}
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        <span aria-hidden="true">{initial}</span>
      )}
    </span>
  );
}

/** 将秒数格式化为高密度短文案（如 14.5h / 45m），用于成员卡片角标。 */
function formatCompactHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const hours = seconds / 3600;
  if (hours >= 10) return `${hours.toFixed(1)}h`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.max(1, Math.round(seconds / 60))}m`;
}

export function PunchStudioPage(): JSX.Element {
  const auth = useOrbitStore((s) => s.auth);
  const ranking = useOrbitStore((s) => s.teamRanking);
  const teamActive = useOrbitStore((s) => s.teamActive);
  const events = useOrbitStore((s) => s.teamEvents);
  const studioMembers = useOrbitStore((s) => s.studioMembers);
  const studioMembersLoading = useOrbitStore((s) => s.studioMembersLoading);
  const studioMembersError = useOrbitStore((s) => s.studioMembersError);
  const refreshStudioMembers = useOrbitStore((s) => s.refreshStudioMembers);
  const memberBlogs = useOrbitStore((s) => s.memberBlogs);
  const openBlogTarget = useOrbitStore((s) => s.openBlogTarget);
  const setActiveTab = useOrbitStore((s) => s.setActiveTab);
  const openTitleCabinet = useOrbitStore((s) => s.openTitleCabinet);

  const [rankFilter, setRankFilter] = useState<'all' | 'qualified'>('all');
  /** 本周专注排行榜年级筛选：默认全部年级（'all'） */
  const [rankGradeFilter, setRankGradeFilter] = useState<string>('all');
  const [memberQuery, setMemberQuery] = useState('');
  /** 默认仅展示当前最新 4 个年级（'recent4'），更早往届收纳进下拉框 */
  const [gradeFilter, setGradeFilter] = useState<string>('recent4');
  const [profileSeed, setProfileSeed] = useState<MemberProfileSeed | null>(null);

  useEffect(() => {
    if (
      auth.authenticated &&
      studioMembers.length === 0 &&
      !studioMembersLoading &&
      !studioMembersError
    ) {
      void refreshStudioMembers();
    }
  }, [auth.authenticated, studioMembers.length, studioMembersLoading, studioMembersError, refreshStudioMembers]);

  const activeKeySet = useMemo(() => {
    const set = new Set<string>();
    for (const item of teamActive) {
      if (item.username) set.add(`u:${item.username.trim().toLowerCase()}`);
      if (item.realName) set.add(`n:${item.realName.trim()}`);
      const stripped = item.displayName.replace(/[（(].*[）)]$/, '').trim();
      if (stripped) set.add(`n:${stripped}`);
    }
    return set;
  }, [teamActive]);

  /** 按 handle 与真名建立周榜快查表，便于在成员卡片上直接融合显示本周时长。 */
  const rankingLookup = useMemo(() => {
    const byHandle = new Map<string, TeamWeeklyRankingItem>();
    const byName = new Map<string, TeamWeeklyRankingItem>();
    for (const item of ranking) {
      if (item.username) byHandle.set(item.username.trim().toLowerCase(), item);
      if (item.realName) byName.set(item.realName.trim(), item);
      const stripped = item.displayName.replace(/[（(].*[）)]$/, '').trim();
      if (stripped && !byName.has(stripped)) byName.set(stripped, item);
    }
    return { byHandle, byName };
  }, [ranking]);

  const isMemberActive = (member: { username?: string | null; name?: string | null; realName?: string; displayName?: string }): boolean => {
    if (member.username && activeKeySet.has(`u:${member.username.trim().toLowerCase()}`)) {
      return true;
    }
    const rawName = (member.realName ?? member.name ?? member.displayName ?? '')
      .replace(/[（(].*[）)]$/, '')
      .trim();
    if (rawName && activeKeySet.has(`n:${rawName}`)) {
      return true;
    }
    return false;
  };

  const findMemberRanking = (member: StudioMemberCard): TeamWeeklyRankingItem | undefined => {
    if (member.username) {
      const hit = rankingLookup.byHandle.get(member.username.trim().toLowerCase());
      if (hit) return hit;
    }
    if (member.name) {
      return rankingLookup.byName.get(member.name.trim());
    }
    return undefined;
  };

  /** 解析成员届别：优先 LecSSO enrollYear，缺失时从本周排行榜 teamName（如「2024级」）自动提取。 */
  const resolveMemberEnrollYear = (member: StudioMemberCard): number | null => {
    if (member.enrollYear) return member.enrollYear;
    const hit = findMemberRanking(member);
    const match = hit?.teamName?.match(/(20\d{2})/);
    return match ? Number(match[1]) : null;
  };

  const totalQualifiedCount = useMemo(
    () => ranking.reduce((acc, item) => acc + (item.qualified ? 1 : 0), 0),
    [ranking],
  );

  /** 提取周榜条目的年级键（如 '2025'），用于周榜按届筛选。 */
  const resolveRankingGradeKey = (item: TeamWeeklyRankingItem): string => {
    const match = item.teamName?.match(/(20\d{2})/);
    return match ? match[1]! : 'unknown';
  };

  /** 周榜可选年级列表（按届数倒序，超过 4 个届别时自动将更早届别收进下拉）。 */
  const { recentRankGrades, olderRankGrades, olderRankTotalCount } = useMemo(() => {
    const counts = new Map<string, { key: string; label: string; count: number }>();
    for (const item of ranking) {
      const key = resolveRankingGradeKey(item);
      const label = key === 'unknown' ? '其他' : `${key}级`;
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { key, label, count: 1 });
    }
    const sorted = Array.from(counts.values()).sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return Number(b.key) - Number(a.key);
    });
    const numeric = sorted.filter((opt) => opt.key !== 'unknown');
    const unknown = sorted.filter((opt) => opt.key === 'unknown');
    const recent = numeric.slice(0, 4);
    const older = [...numeric.slice(4), ...unknown];
    return {
      recentRankGrades: recent,
      olderRankGrades: older,
      olderRankTotalCount: older.reduce((sum, opt) => sum + opt.count, 0),
    };
  }, [ranking]);

  const isOlderRankDropdownActive = olderRankGrades.some((opt) => opt.key === rankGradeFilter);

  const gradeFilteredRanking = useMemo(
    () =>
      rankGradeFilter === 'all'
        ? ranking
        : ranking.filter((r) => resolveRankingGradeKey(r) === rankGradeFilter),
    [ranking, rankGradeFilter],
  );

  const qualifiedCount = useMemo(
    () => gradeFilteredRanking.reduce((acc, item) => acc + (item.qualified ? 1 : 0), 0),
    [gradeFilteredRanking],
  );

  const visibleRanking = useMemo(
    () =>
      rankFilter === 'qualified'
        ? gradeFilteredRanking.filter((r) => r.qualified)
        : gradeFilteredRanking,
    [gradeFilteredRanking, rankFilter],
  );

  /** 可供筛选的年级选项列表（按届数倒序），拆分为最新 4 级平铺与往届下拉两组。 */
  const { recentGradeOptions, olderGradeOptions, recentGradeKeys, olderTotalCount } = useMemo(() => {
    const counts = new Map<string, { key: string; label: string; count: number }>();
    for (const m of studioMembers) {
      const year = resolveMemberEnrollYear(m);
      const key = year ? String(year) : 'unknown';
      const label = year ? `${year}级` : '其他';
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { key, label, count: 1 });
    }
    const sorted = Array.from(counts.values()).sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return Number(b.key) - Number(a.key);
    });
    const numeric = sorted.filter((opt) => opt.key !== 'unknown');
    const unknown = sorted.filter((opt) => opt.key === 'unknown');
    const recent = numeric.slice(0, 4);
    const older = [...numeric.slice(4), ...unknown];
    return {
      recentGradeOptions: recent,
      olderGradeOptions: older,
      recentGradeKeys: new Set(recent.map((opt) => opt.key)),
      olderTotalCount: older.reduce((sum, opt) => sum + opt.count, 0),
    };
  }, [studioMembers, rankingLookup]);

  const isOlderDropdownActive =
    gradeFilter === 'all' || olderGradeOptions.some((opt) => opt.key === gradeFilter);

  const filteredMemberGroups = useMemo<GradeGroup[]>(() => {
    const keyword = memberQuery.trim().toLowerCase();
    const matched = studioMembers.filter((m) => {
      const year = resolveMemberEnrollYear(m);
      const key = year ? String(year) : 'unknown';
      if (gradeFilter === 'recent4') {
        // 默认未搜索时仅展示当前最新 4 级；输入搜索词时跨全员检索，避免搜不到往届成员
        if (!keyword && recentGradeKeys.size > 0 && !recentGradeKeys.has(key)) return false;
      } else if (gradeFilter !== 'all' && key !== gradeFilter) {
        return false;
      }
      if (!keyword) return true;
      const hay = [
        m.name ?? '',
        m.username ?? '',
        year ? `${year}级` : '',
        m.social.github?.username ?? '',
        m.social.github?.name ?? '',
        m.social.feishu?.name ?? '',
        m.social.feishu?.enName ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(keyword);
    });

    const bucket = new Map<string, GradeGroup>();
    for (const m of matched) {
      const year = resolveMemberEnrollYear(m);
      const key = year ? String(year) : 'unknown';
      const label = year ? `${year} 级` : '其他成员';
      const existing = bucket.get(key);
      if (existing) existing.members.push(m);
      else bucket.set(key, { key, label, members: [m] });
    }

    return Array.from(bucket.values()).sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return Number(b.key) - Number(a.key);
    });
  }, [studioMembers, memberQuery, gradeFilter, recentGradeKeys, rankingLookup]);

  /** 按 userId / username 建立成员博客快查表，用于在成员名片上直接呈现站点 Logo 并直达阅读。 */
  const blogLookup = useMemo(() => {
    const byId = new Map<string, MemberBlogItem>();
    const byHandle = new Map<string, MemberBlogItem>();
    for (const b of memberBlogs) {
      if (b.userId) byId.set(b.userId, b);
      if (b.username) byHandle.set(b.username.trim().toLowerCase(), b);
    }
    return { byId, byHandle };
  }, [memberBlogs]);

  const findMemberBlog = (member: StudioMemberCard): MemberBlogItem | undefined => {
    const byId = blogLookup.byId.get(member.id);
    if (byId) return byId;
    if (member.username) return blogLookup.byHandle.get(member.username.trim().toLowerCase());
    return undefined;
  };

  const openMemberBlog = (blog: MemberBlogItem) => {
    openBlogTarget(blog.userId, blog.blogUrl);
    setActiveTab('blogs');
  };

  const openAdminInBrowser = () => {
    const base = getOrbitEndpoints().punchWebUrl;
    void getOrbitClient().system.openExternal(`${base}/admin-dashboard`);
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.titleLine}>
            <h1 className={styles.heading}>工作室动态</h1>
            <div className={styles.statChips}>
              <span className={`${styles.statChip} ${styles.statChipOnline}`}>
                <Radio size={11} />
                在岗 {teamActive.length} 人
              </span>
              <span className={styles.statChip}>
                <CheckCircle2 size={11} />
                本周达标 {totalQualifiedCount}/{ranking.length}
              </span>
              {studioMembers.length > 0 && (
                <span className={styles.statChip}>
                  <Users size={11} />
                  成员 {studioMembers.length} 人
                </span>
              )}
            </div>
          </div>
          <p className={styles.subheading}>
            本周专注排行与工作室成员同屏速览 · 点击任意成员查看公开资料、GitHub 与飞书绑定状态
          </p>
        </div>
        <div className={styles.actions}>
          <SegmentedControl
            value="studio"
            onValueChange={(v) => {
              if (v === 'blogs') setActiveTab('blogs');
            }}
            items={[
              { value: 'studio', label: '动态与名录' },
              {
                value: 'blogs',
                label: memberBlogs.length > 0 ? `成员博客 (${memberBlogs.length})` : '成员博客',
              },
            ]}
          />
          {auth.authenticated && (
            <Button
              variant="glass"
              size="small"
              icon={<Award size={14} />}
              onClick={() => openTitleCabinet()}
            >
              我的称号
            </Button>
          )}
          <Button
            variant="glass"
            size="small"
            icon={<RefreshCw size={13} />}
            loading={studioMembersLoading}
            onClick={() => void refreshStudioMembers(true)}
          >
            刷新名录
          </Button>
          {auth.isAdmin && (
            <Button
              variant="glass"
              size="small"
              icon={<ExternalLink size={14} />}
              onClick={openAdminInBrowser}
            >
              管理后台
            </Button>
          )}
        </div>
      </header>

      {/* 高密度双栏 Bento 主区：左栏周榜 + 右栏（近期活动 & 成员名录） */}
      <div className={styles.boardGrid}>
        {/* 左栏：本周专注排行榜 */}
        <section className={`${styles.panel} ${styles.rankingPanel}`}>
          <div className={styles.panelHeadRow}>
            <div className={styles.panelTitle}>
              <span className={styles.cardTitle}>
                <Trophy size={15} /> 本周专注排行榜
              </span>
              <span className={`${styles.litePill} ${styles.pillNeutral}`}>
                {visibleRanking.length} 人
              </span>
            </div>
            <div className={styles.miniSwitch}>
              <button
                type="button"
                className={`${styles.chipBtn} ${rankFilter === 'all' ? styles.chipBtnActive : ''}`}
                onClick={() => setRankFilter('all')}
              >
                全部
              </button>
              <button
                type="button"
                className={`${styles.chipBtn} ${rankFilter === 'qualified' ? styles.chipBtnActive : ''}`}
                onClick={() => setRankFilter('qualified')}
              >
                已达标 ({qualifiedCount})
              </button>
            </div>
          </div>

          {ranking.length > 0 && (recentRankGrades.length > 0 || olderRankGrades.length > 0) && (
            <div className={styles.filterBar}>
              <button
                type="button"
                className={`${styles.chipBtn} ${rankGradeFilter === 'all' ? styles.chipBtnActive : ''}`}
                onClick={() => setRankGradeFilter('all')}
              >
                全部年级
              </button>
              {recentRankGrades.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`${styles.chipBtn} ${rankGradeFilter === opt.key ? styles.chipBtnActive : ''}`}
                  onClick={() => setRankGradeFilter(opt.key)}
                >
                  {opt.label} ({opt.count})
                </button>
              ))}
              {olderRankGrades.length > 0 && (
                <label
                  className={`${styles.gradeSelectWrap} ${
                    isOlderRankDropdownActive ? styles.gradeSelectActive : ''
                  }`}
                >
                  <select
                    aria-label="筛选周榜其他届别"
                    className={styles.gradeSelect}
                    value={isOlderRankDropdownActive ? rankGradeFilter : ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRankGradeFilter(val || 'all');
                    }}
                  >
                    <option value="">更多届别 ({olderRankTotalCount})</option>
                    {olderRankGrades.map((opt) => (
                      <option key={opt.key} value={opt.key}>
                        {opt.label} ({opt.count})
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} className={styles.gradeSelectArrow} aria-hidden="true" />
                </label>
              )}
            </div>
          )}

          {visibleRanking.length === 0 ? (
            <Empty
              title={
                rankFilter === 'qualified'
                  ? rankGradeFilter === 'all'
                    ? '本周暂无达标成员'
                    : '该年级本周暂无达标成员'
                  : '暂无本周排行数据'
              }
              description={
                rankFilter === 'qualified'
                  ? '切换到「全部」或「全部年级」查看其他成员的累计时长'
                  : '登录后将自动同步团队本周专注排行'
              }
            />
          ) : (
            <ol className={styles.rankList}>
              {visibleRanking.map((item, idx) => {
                const rankNo = rankGradeFilter === 'all' ? (item.rank ?? idx + 1) : idx + 1;
                const online = isMemberActive(item);
                const rankMedalClass =
                  rankNo === 1
                    ? styles.rankGold
                    : rankNo === 2
                      ? styles.rankSilver
                      : rankNo === 3
                        ? styles.rankBronze
                        : '';
                return (
                  <li key={item.userId} className={styles.rankItem}>
                    <button
                      type="button"
                      className={styles.rankRowBtn}
                      onClick={() =>
                        setProfileSeed({
                          id: item.userId,
                          username: item.username,
                          displayName: item.displayName,
                          realName: item.realName,
                          nickname: item.nickname,
                          avatar: item.avatar,
                          teamName: item.teamName,
                          titles: item.titles,
                          ranking: { ...item, rank: rankNo },
                        })
                      }
                    >
                      <div className={styles.rankLeft}>
                        <span className={`${styles.rankIndex} ${rankMedalClass}`}>{rankNo}</span>
                        <div className={styles.avatarAnchor}>
                          <LiteAvatar
                            src={item.avatar}
                            name={item.realName || item.displayName}
                            size="xs"
                          />
                          {online && <span className={styles.onlineDotSm} title="正在工作室专注中" />}
                        </div>
                        <div className={styles.rankText}>
                          <div className={styles.rankNameRow}>
                            <span className={styles.rankName}>{item.displayName}</span>
                            {item.teamName && (
                              <span className={styles.rankTeamInline}>{item.teamName}</span>
                            )}
                            <TitleBadgeList
                              titles={item.titles}
                              size="xs"
                              maxVisible={1}
                              singleLine
                              overflowPopover
                            />
                          </div>
                        </div>
                      </div>
                      <div className={styles.rankRight}>
                        {item.qualified && (
                          <span className={`${styles.litePill} ${styles.pillSuccess}`}>达标</span>
                        )}
                        <span className={styles.rankDuration}>
                          {formatReadableDuration(item.totalDurationSeconds)}
                        </span>
                        <ChevronRight size={13} className={styles.rowChevron} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* 右栏：近期活动（有则显示）+ 工作室成员名录 */}
        <div className={styles.rightColumn}>
          {events.length > 0 && (
            <section className={styles.panel}>
              <div className={styles.panelHeadRow}>
                <div className={styles.panelTitle}>
                  <span className={styles.cardTitle}>
                    <CalendarDays size={15} /> 近期团队活动
                  </span>
                  <span className={`${styles.litePill} ${styles.pillInfo}`}>{events.length}</span>
                </div>
              </div>
              <ul className={styles.eventList}>
                {events.map((ev) => (
                  <li key={ev.id} className={styles.eventRow}>
                    <div className={styles.eventMain}>
                      <div className={styles.eventTitle}>{ev.title}</div>
                      {ev.description && <p className={styles.eventDesc}>{ev.description}</p>}
                    </div>
                    <div className={styles.eventMeta}>
                      {ev.startTime && (
                        <span className={`${styles.litePill} ${styles.pillNeutral}`}>
                          {new Date(ev.startTime).toLocaleDateString('zh-CN')}
                        </span>
                      )}
                      {ev.location && (
                        <span className={`${styles.litePill} ${styles.pillInfo}`}>
                          {ev.location}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={`${styles.panel} ${styles.membersPanel}`}>
            <div className={styles.panelHeadRow}>
              <div className={styles.panelTitle}>
                <span className={styles.cardTitle}>
                  <Users size={15} /> 工作室成员名片
                </span>
                {studioMembers.length > 0 && (
                  <span className={`${styles.litePill} ${styles.pillNeutral}`}>
                    {studioMembers.length} 人
                  </span>
                )}
              </div>
              <div className={styles.memberSearchWrap}>
                <Input
                  value={memberQuery}
                  onValueChange={setMemberQuery}
                  placeholder="搜姓名 / Handle / GitHub…"
                  icon={<Search size={13} />}
                />
              </div>
            </div>

            {studioMembers.length > 0 && (
              <div className={styles.filterBar}>
                <button
                  type="button"
                  className={`${styles.chipBtn} ${gradeFilter === 'recent4' ? styles.chipBtnActive : ''}`}
                  onClick={() => setGradeFilter('recent4')}
                >
                  当前在读
                </button>
                {recentGradeOptions.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`${styles.chipBtn} ${gradeFilter === opt.key ? styles.chipBtnActive : ''}`}
                    onClick={() => setGradeFilter(opt.key)}
                  >
                    {opt.label} ({opt.count})
                  </button>
                ))}
                {olderGradeOptions.length > 0 && (
                  <label
                    className={`${styles.gradeSelectWrap} ${
                      isOlderDropdownActive ? styles.gradeSelectActive : ''
                    }`}
                  >
                    <select
                      aria-label="切换往届或全部届别"
                      className={styles.gradeSelect}
                      value={isOlderDropdownActive ? gradeFilter : ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGradeFilter(val || 'recent4');
                      }}
                    >
                      <option value="">往届 ({olderTotalCount})</option>
                      {olderGradeOptions.map((opt) => (
                        <option key={opt.key} value={opt.key}>
                          {opt.label} ({opt.count})
                        </option>
                      ))}
                      <option value="all">全部届别 ({studioMembers.length})</option>
                    </select>
                    <ChevronDown size={12} className={styles.gradeSelectArrow} aria-hidden="true" />
                  </label>
                )}
              </div>
            )}

            {studioMembersError && (
              <Message
                tone="error"
                action={{ label: '重试', onClick: () => void refreshStudioMembers(true) }}
              >
                {studioMembersError}
              </Message>
            )}

            {studioMembersLoading && studioMembers.length === 0 ? (
              <Empty title="正在同步工作室成员名片…" description="首次加载会从 LecSSO 拉取正式成员资料" />
            ) : filteredMemberGroups.length === 0 ? (
              <Empty
                title={memberQuery.trim() ? '未找到匹配的成员' : '暂无工作室成员数据'}
                description={
                  memberQuery.trim()
                    ? '试试清空搜索词或切换其他届别'
                    : '点击右上角「刷新名录」重新同步'
                }
              />
            ) : (
              <div className={styles.gradeGroups}>
                {filteredMemberGroups.map((group) => (
                  <section key={group.key} className={styles.gradeSection}>
                    <div className={styles.gradeHeader}>
                      <span className={styles.gradeTitle}>{group.label}</span>
                      <span className={styles.gradeCount}>{group.members.length} 人</span>
                    </div>
                    <div className={styles.memberGrid}>
                      {group.members.map((member) => {
                        const role = resolvePrimaryStudioRole(member.roles);
                        const online = isMemberActive(member);
                        const memberRank = findMemberRanking(member);
                        const memberBlog = findMemberBlog(member);
                        const hasGithub = Boolean(member.social.github);
                        const hasFeishu = Boolean(member.social.feishu);
                        const hasBlog = Boolean(memberBlog);
                        return (
                          <button
                            key={member.id}
                            type="button"
                            className={styles.memberCard}
                            onClick={() =>
                              setProfileSeed({
                                id: member.id,
                                username: member.username,
                                displayName: member.name || member.username || '工作室成员',
                                realName: member.name ?? undefined,
                                avatar: member.avatar,
                                studioMember: member,
                                ranking: memberRank,
                              })
                            }
                          >
                            <div className={styles.memberCardTop}>
                              <div className={styles.avatarAnchor}>
                                <LiteAvatar
                                  src={member.avatar ?? undefined}
                                  name={member.name || member.username || '成员'}
                                  size="small"
                                />
                                {online && (
                                  <span className={styles.memberOnlineDot} title="正在工作室专注中" />
                                )}
                              </div>
                              <div className={styles.memberCardMeta}>
                                <div className={styles.memberCardNameRow}>
                                  <span className={styles.memberCardName}>
                                    {member.name || member.username || '工作室成员'}
                                  </span>
                                  {role.tone !== 'neutral' && (
                                    <span
                                      className={`${styles.litePillXs} ${
                                        role.tone === 'warning' ? styles.pillWarning : styles.pillInfo
                                      }`}
                                    >
                                      {role.label}
                                    </span>
                                  )}
                                </div>
                                <div className={styles.memberCardHandle}>
                                  {member.username ? `@${member.username}` : 'LEC 正式成员'}
                                </div>
                              </div>
                            </div>

                            <div className={styles.memberCardFoot}>
                              <div className={styles.memberSocialPills}>
                                {hasGithub && (
                                  <span
                                    className={styles.memberSocialPill}
                                    title={
                                      member.social.github?.username
                                        ? `GitHub: @${member.social.github.username}`
                                        : '已绑定 GitHub'
                                    }
                                  >
                                    <SocialBrandGlyph target="github" size={11} />
                                    {member.social.github?.username && (
                                      <span>@{member.social.github.username}</span>
                                    )}
                                  </span>
                                )}
                                {hasFeishu && (
                                  <span className={styles.memberSocialPill} title="已绑定工作室飞书">
                                    <SocialBrandGlyph target="feishu" size={11} />
                                  </span>
                                )}
                                {hasBlog && memberBlog && (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    className={`${styles.memberSocialPill} ${styles.memberBlogPill}`}
                                    title={`访问博客：${memberBlog.blogTitle || memberBlog.blogUrl}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openMemberBlog(memberBlog);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openMemberBlog(memberBlog);
                                      }
                                    }}
                                  >
                                    <BlogSiteLogo blogUrl={memberBlog.blogUrl} size={11} />
                                    <span>Blog</span>
                                  </span>
                                )}
                                {!hasGithub && !hasFeishu && !hasBlog && (
                                  <span className={styles.memberNoSocial}>名片</span>
                                )}
                              </div>
                              {memberRank && memberRank.totalDurationSeconds > 0 ? (
                                <span
                                  className={`${styles.memberWeekHours} ${
                                    memberRank.qualified ? styles.memberWeekQualified : ''
                                  }`}
                                  title={`本周专注 ${formatReadableDuration(memberRank.totalDurationSeconds)}`}
                                >
                                  {formatCompactHours(memberRank.totalDurationSeconds)}
                                </span>
                              ) : (
                                <ChevronRight size={12} className={styles.rowChevron} />
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <MemberProfileDialog seed={profileSeed} onClose={() => setProfileSeed(null)} />
    </div>
  );
}
