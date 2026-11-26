/** 工坊作品全员可见游玩统计、近 14 天趋势折线图、近 35 天热力图、防刷评分与「谁玩过」明细弹窗。 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Button, Dialog, Empty, Message, TextArea } from '@lec-space/liquidglass';
import { Activity, BarChart3, Clock, Flame, Gamepad2, MessageSquare, Star, Users } from 'lucide-react';
import { formatReadableDuration } from '@shared/punch';
import {
  orbitServerApi,
  type MiniAppDailyTrendPoint,
  type MiniAppEngagementStats,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import styles from './MiniAppEngagementDialog.module.css';

export interface MiniAppEngagementTarget {
  appId: string;
  name: string;
  initialTab?: 'reviews' | 'players';
}

interface MiniAppEngagementDialogProps {
  target: MiniAppEngagementTarget | null;
  onClose: () => void;
  onRated?: () => void;
}

function MiniAvatar({ src, name }: { src?: string; name: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || '?';
  return (
    <span className={styles.avatar} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" className={styles.avatarImg} onError={() => setFailed(true)} />
      ) : (
        initial
      )}
    </span>
  );
}

/** 轻量无依赖 SVG 折线面积图：展示近 14 天每日游玩局数与独立游玩人数。 */
function PlayTrendLineChart({ data }: { data: MiniAppDailyTrendPoint[] }): JSX.Element {
  const recent14 = useMemo(() => data.slice(-14), [data]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 320;
  const height = 104;
  const padX = 12;
  const padTop = 12;
  const padBottom = 18;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max(
    1,
    ...recent14.map((d) => Math.max(d.plays, d.uniquePlayers)),
  );

  const coords = recent14.map((d, idx) => {
    const x = recent14.length > 1 ? padX + (idx / (recent14.length - 1)) * plotW : padX + plotW / 2;
    const yPlays = padTop + plotH - (d.plays / maxVal) * plotH;
    const yUsers = padTop + plotH - (d.uniquePlayers / maxVal) * plotH;
    return { ...d, x, yPlays, yUsers };
  });

  const playsLine = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yPlays.toFixed(1)}`).join(' ');
  const usersLine = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.yUsers.toFixed(1)}`).join(' ');
  const areaPath =
    coords.length > 0
      ? `${playsLine} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
      : '';

  const hovered = hoverIdx !== null ? coords[hoverIdx] : null;

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartHead}>
        <span className={styles.chartTitle}>
          <Activity size={12} /> 近 14 天游玩趋势
        </span>
        <span className={styles.chartLegend}>
          {hovered ? (
            <strong>
              {hovered.day.slice(5)} · {hovered.plays} 局 / {hovered.uniquePlayers} 人
            </strong>
          ) : (
            <>
              <span className={styles.legendDotPlays} /> 局数
              <span className={styles.legendDotUsers} /> 人数
            </>
          )}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={styles.lineSvg}
        role="img"
        aria-label="近 14 天游玩趋势折线图"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="hubPlayAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0a84ff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0a84ff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 水平参考线 */}
        {[0, 0.5, 1].map((ratio) => {
          const y = padTop + plotH * ratio;
          return (
            <line
              key={ratio}
              x1={padX}
              y1={y}
              x2={width - padX}
              y2={y}
              className={styles.gridLine}
            />
          );
        })}
        {areaPath && <path d={areaPath} fill="url(#hubPlayAreaGrad)" />}
        {usersLine && <path d={usersLine} className={styles.usersPath} fill="none" />}
        {playsLine && <path d={playsLine} className={styles.playsPath} fill="none" />}
        {coords.map((pt, idx) => (
          <g key={pt.day} onMouseEnter={() => setHoverIdx(idx)}>
            <rect
              x={pt.x - plotW / Math.max(2, coords.length * 2)}
              y={padTop}
              width={plotW / Math.max(1, coords.length)}
              height={plotH}
              fill="transparent"
            />
            <circle
              cx={pt.x}
              cy={pt.yPlays}
              r={hoverIdx === idx ? 3.5 : pt.plays > 0 ? 2 : 1.2}
              className={styles.playsDot}
            />
          </g>
        ))}
        {/* 起止日期标注 */}
        {coords.length > 0 && (
          <>
            <text x={padX} y={height - 3} className={styles.axisText}>
              {coords[0]!.day.slice(5)}
            </text>
            <text
              x={width - padX}
              y={height - 3}
              textAnchor="end"
              className={styles.axisText}
            >
              {coords[coords.length - 1]!.day.slice(5)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

/** 轻量 35 天游玩热力图（5 周 × 7 天色块网格）。 */
function PlayHeatmap({ data }: { data: MiniAppDailyTrendPoint[] }): JSX.Element {
  const recent35 = useMemo(() => data.slice(-35), [data]);
  const [hovered, setHovered] = useState<MiniAppDailyTrendPoint | null>(null);
  const maxPlays = Math.max(1, ...recent35.map((d) => d.plays));

  const levelOf = (plays: number): number => {
    if (plays <= 0) return 0;
    const ratio = plays / maxPlays;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.55) return 2;
    if (ratio <= 0.8) return 3;
    return 4;
  };

  return (
    <div className={styles.chartCard}>
      <div className={styles.chartHead}>
        <span className={styles.chartTitle}>
          <Flame size={12} /> 近 35 天游玩热力图
        </span>
        <span className={styles.chartLegend}>
          {hovered ? (
            <strong>
              {hovered.day.slice(5)} · {hovered.plays} 局 ({hovered.uniquePlayers}人)
            </strong>
          ) : (
            <span>低 → 高</span>
          )}
        </span>
      </div>
      <div
        className={styles.heatmapGrid}
        onMouseLeave={() => setHovered(null)}
        role="img"
        aria-label="近 35 天游玩热力图"
      >
        {recent35.map((d) => {
          const lvl = levelOf(d.plays);
          return (
            <span
              key={d.day}
              className={`${styles.heatCell} ${styles[`heatL${lvl}`]}`}
              title={`${d.day}：${d.plays} 局（${d.uniquePlayers} 人游玩）`}
              onMouseEnter={() => setHovered(d)}
            />
          );
        })}
      </div>
    </div>
  );
}

export function MiniAppEngagementDialog({
  target,
  onClose,
  onRated,
}: MiniAppEngagementDialogProps): JSX.Element {
  const [stats, setStats] = useState<MiniAppEngagementStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'players' | 'reviews'>('players');

  const [score, setScore] = useState<number>(5);
  const [hoverScore, setHoverScore] = useState<number>(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadStats = async (appId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await orbitServerApi.getMiniAppStats(appId);
      setStats(data);
      if (data.myRating) {
        setScore(data.myRating.score);
        setComment(data.myRating.comment);
      } else {
        setScore(5);
        setComment('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取作品数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!target) {
      setStats(null);
      return;
    }
    setTab(target.initialTab ?? 'players');
    void loadStats(target.appId);
  }, [target]);

  const handleSubmitRating = async () => {
    if (!target || !stats || submitting) return;
    setSubmitting(true);
    try {
      await orbitServerApi.rateMiniApp(target.appId, {
        score,
        comment: comment.trim(),
      });
      notifyToast({
        tone: 'success',
        title: stats.myRating ? '评分已更新' : '评分已提交',
        description: `已为《${target.name}》给出 ${score} 星评价`,
      });
      await loadStats(target.appId);
      onRated?.();
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '提交评分失败',
        description: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const canRateNow = Boolean(
    stats &&
      !stats.isOwner &&
      stats.myRatingChances > 0 &&
      stats.dailyRatingsRemaining > 0 &&
      stats.dailyAppRatingsRemaining > 0,
  );

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="large"
      title={target ? `《${target.name}》游玩趋势、明细与评分` : '游玩数据与评分'}
      description="游玩趋势与谁玩过对全体成员公开 · 启动并结束一局可获 1 次评分机会（不叠加）"
      footer={
        <Button variant="glass" size="small" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {error && <Message tone="error">{error}</Message>}

      {loading && !stats ? (
        <Empty title="正在加载游玩统计与评价…" />
      ) : stats ? (
        <div className={styles.body}>
          {/* 顶部 4 项统计 */}
          <div className={styles.statGrid}>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>
                <Star size={12} /> 综合评分
              </span>
              <strong className={styles.statValue}>
                {stats.avgRating !== null ? `${stats.avgRating.toFixed(1)} ★` : '暂无'}
              </strong>
              <span className={styles.statSub}>{stats.ratingCount} 人评分</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>
                <Users size={12} /> 游玩人数
              </span>
              <strong className={styles.statValue}>{stats.uniquePlayers}</strong>
              <span className={styles.statSub}>累计 {stats.totalPlays} 局</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>
                <Gamepad2 size={12} /> 当前在玩
              </span>
              <strong className={styles.statValue}>{stats.activePlayers.length}</strong>
              <span className={styles.statSub}>实时在线</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statLabel}>
                <BarChart3 size={12} /> 我的记录
              </span>
              <strong className={styles.statValue}>{stats.myPlayCount} 局</strong>
              <span className={styles.statSub}>
                {stats.isOwner
                  ? '作品作者'
                  : stats.myRatingChances > 0
                    ? '可评分 ×1'
                    : '暂无评分机会'}
              </span>
            </div>
          </div>

          {/* 折线图 + 热力图双栏可视化 */}
          {stats.dailyTrend && stats.dailyTrend.length > 0 && (
            <div className={styles.chartsGrid}>
              <PlayTrendLineChart data={stats.dailyTrend} />
              <PlayHeatmap data={stats.dailyTrend} />
            </div>
          )}

          {/* 评分面板（非作者展示） */}
          {!stats.isOwner && (
            <div className={styles.rateBox}>
              <div className={styles.rateHead}>
                <span className={styles.rateTitle}>
                  {stats.myRating ? `我的评分（当前 ${stats.myRating.score} ★）` : '给这部作品打个分'}
                </span>
                <span className={styles.rateQuota}>
                  评分机会：{stats.myRatingChances}/1 · 今日剩余 {stats.dailyRatingsRemaining}/
                  {stats.dailyMaxRatingsGlobal}
                </span>
              </div>

              {canRateNow ? (
                <>
                  <div className={styles.starsRow} role="radiogroup" aria-label="选择星级">
                    {[1, 2, 3, 4, 5].map((star) => {
                      const active = star <= (hoverScore || score);
                      return (
                        <button
                          key={star}
                          type="button"
                          className={`${styles.starBtn} ${active ? styles.starBtnActive : ''}`}
                          aria-label={`${star} 星`}
                          onMouseEnter={() => setHoverScore(star)}
                          onMouseLeave={() => setHoverScore(0)}
                          onClick={() => setScore(star)}
                        >
                          <Star size={20} fill={active ? 'currentColor' : 'none'} />
                        </button>
                      );
                    })}
                    <span className={styles.scoreLabel}>{hoverScore || score} 星</span>
                  </div>
                  <TextArea
                    rows={2}
                    placeholder="写一句体验感受或给作者的建议（选填，最多 200 字）…"
                    value={comment}
                    onValueChange={setComment}
                  />
                  <div className={styles.rateFoot}>
                    <span className={styles.rateTip}>
                      提交后消耗本次评分机会；每局游玩封顶 1 次，同一作品每天最多评 {stats.dailyMaxRatingsPerApp} 次
                    </span>
                    <Button
                      variant="filled"
                      size="small"
                      loading={submitting}
                      onClick={() => void handleSubmitRating()}
                    >
                      {stats.myRating ? '更新评分' : '提交评分'}
                    </Button>
                  </div>
                </>
              ) : (
                <p className={styles.rateHint}>
                  {stats.myRatingChances < 1
                    ? '先打开并玩完一局（关闭应用即结算一局），即可获得 1 次评分机会。'
                    : stats.dailyRatingsRemaining <= 0
                      ? `你今天的评分次数已达上限（每天最多 ${stats.dailyMaxRatingsGlobal} 次），明天再来评价吧。`
                      : `今天对该作品的评分次数已达上限（同一作品每天最多 ${stats.dailyMaxRatingsPerApp} 次）。`}
                </p>
              )}
            </div>
          )}

          {/* 全员可见：谁玩过明细 & 评价切换（紧凑左对齐胶囊，不拉满整行） */}
          <div className={styles.sectionTabBar} role="tablist" aria-label="游玩明细与评价切换">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'players'}
              className={`${styles.sectionTabBtn} ${tab === 'players' ? styles.sectionTabBtnActive : ''}`}
              onClick={() => setTab('players')}
            >
              <Users size={13} />
              <span>谁玩过</span>
              <span className={styles.sectionTabCount}>{stats.players.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'reviews'}
              className={`${styles.sectionTabBtn} ${tab === 'reviews' ? styles.sectionTabBtnActive : ''}`}
              onClick={() => setTab('reviews')}
            >
              <MessageSquare size={13} />
              <span>全部评价</span>
              <span className={styles.sectionTabCount}>{stats.reviews.length}</span>
            </button>
          </div>

          {tab === 'players' ? (
            stats.players.length === 0 ? (
              <Empty title="还没有同学玩过这部作品" description="有同学启动并结束游玩后，这里会展示详细游玩记录" />
            ) : (
              <ul className={styles.list}>
                {stats.players.map((p) => (
                  <li key={p.userId} className={styles.row}>
                    <MiniAvatar src={p.avatar} name={p.displayName} />
                    <div className={styles.rowMain}>
                      <div className={styles.rowTop}>
                        <strong className={styles.rowName}>{p.displayName}</strong>
                        {p.enrollYear && <span className={styles.gradeTag}>{p.enrollYear}级</span>}
                        {p.score !== null && (
                          <span className={styles.starPill}>★ {p.score}</span>
                        )}
                      </div>
                      <div className={styles.rowSub}>
                        <span>玩了 {p.playCount} 局</span>
                        {p.totalDurationSeconds > 0 && (
                          <span>
                            <Clock size={10} /> {formatReadableDuration(p.totalDurationSeconds)}
                          </span>
                        )}
                        <span>最近：{new Date(p.lastPlayedAt).toLocaleString('zh-CN')}</span>
                      </div>
                      {p.comment && <p className={styles.rowComment}>“{p.comment}”</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : stats.reviews.length === 0 ? (
            <Empty
              icon={<MessageSquare size={22} />}
              title="暂无评分与评价"
              description="体验完一局后可以成为第一个评分的同学"
            />
          ) : (
            <ul className={styles.list}>
              {stats.reviews.map((r) => (
                <li key={r.userId} className={styles.row}>
                  <MiniAvatar src={r.avatar} name={r.displayName} />
                  <div className={styles.rowMain}>
                    <div className={styles.rowTop}>
                      <strong className={styles.rowName}>{r.displayName}</strong>
                      {r.enrollYear && <span className={styles.gradeTag}>{r.enrollYear}级</span>}
                      <span className={styles.starPill}>{'★'.repeat(r.score)}</span>
                      <span className={styles.timeText}>
                        {new Date(r.ratedAt).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                    {r.comment ? (
                      <p className={styles.rowComment}>{r.comment}</p>
                    ) : (
                      <p className={styles.rowCommentMuted}>给出了 {r.score} 星好评</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
