/**
 * Orbit 工坊「托管云函数工作台」弹窗（仅作品作者与队长可见）：
 * - 源码审查：查看某版本随包提交的 functions/ 源码、路由、超时/流式声明与 .wasm 产物；
 * - 加密 Secrets：作者自助配置 AES-256-GCM 静态加密环境变量，保存后永不回显明文；
 * - 调用日志：实时查看最近 50 次调用状态码、耗时与 console 输出，便于线上排错。
 */
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';
import {
  Button,
  Dialog,
  Empty,
  Input,
  Message,
  SegmentedControl,
  Tag,
} from '@lec-space/liquidglass';
import {
  Binary,
  KeyRound,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { formatBytesCompact } from '@shared/miniapp';
import {
  orbitServerApi,
  type MiniAppFnLogEntry,
  type MiniAppSecretSummary,
  type MiniAppVersionFunctionsSource,
} from '@/services/orbitServerApi';
import { notifyToast } from '@/services/orbitToast';
import styles from './MiniAppFunctionsDialog.module.css';

export type FunctionsDialogTab = 'source' | 'secrets' | 'logs';

export interface MiniAppFunctionsDialogTarget {
  appId: string;
  appName: string;
  versionId?: string;
  versionLabel?: string;
  initialTab?: FunctionsDialogTab;
}

interface MiniAppFunctionsDialogProps {
  target: MiniAppFunctionsDialogTarget | null;
  onClose: () => void;
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,47}$/;

function formatTimeCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function MiniAppFunctionsDialog({
  target,
  onClose,
}: MiniAppFunctionsDialogProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<FunctionsDialogTab>('source');

  // 源码审查状态
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceData, setSourceData] = useState<MiniAppVersionFunctionsSource | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');

  // Secrets 状态
  const [secretsLoading, setSecretsLoading] = useState(false);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<MiniAppSecretSummary[]>([]);
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretSaving, setSecretSaving] = useState(false);
  const [deletingSecret, setDeletingSecret] = useState<string | null>(null);

  // 调用日志状态
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logs, setLogs] = useState<MiniAppFnLogEntry[]>([]);

  const loadSource = useCallback(async (appId: string, versionId?: string) => {
    if (!versionId) {
      setSourceData(null);
      setSourceError(null);
      return;
    }
    setSourceLoading(true);
    setSourceError(null);
    try {
      const data = await orbitServerApi.getMiniAppFunctionsSource(appId, versionId);
      setSourceData(data);
      setSelectedFilePath((prev) =>
        data.files.some((f) => f.path === prev) ? prev : (data.files[0]?.path ?? ''),
      );
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : '加载云函数源码失败');
    } finally {
      setSourceLoading(false);
    }
  }, []);

  const loadSecrets = useCallback(async (appId: string) => {
    setSecretsLoading(true);
    setSecretsError(null);
    try {
      const items = await orbitServerApi.listMiniAppSecrets(appId);
      setSecrets(items);
    } catch (err) {
      setSecretsError(err instanceof Error ? err.message : '加载加密环境变量失败');
    } finally {
      setSecretsLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async (appId: string) => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const items = await orbitServerApi.listMiniAppFnLogs(appId, 50);
      setLogs(items);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : '加载云函数调用日志失败');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!target) return;
    const nextTab = target.initialTab ?? (target.versionId ? 'source' : 'secrets');
    setActiveTab(nextTab);
    setSecretName('');
    setSecretValue('');
    setSourceData(null);
    setSelectedFilePath('');
    void loadSource(target.appId, target.versionId);
    void loadSecrets(target.appId);
    void loadLogs(target.appId);
  }, [target, loadSource, loadSecrets, loadLogs]);

  const handleSaveSecret = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    const cleanName = secretName.trim().toUpperCase();
    if (!SECRET_NAME_RE.test(cleanName)) {
      notifyToast({
        tone: 'error',
        title: '变量名格式不合法',
        description: '需以大写字母开头，由 2~48 位大写字母、数字或下划线组成（如 DEEPSEEK_API_KEY）',
      });
      return;
    }
    if (!secretValue.trim()) {
      notifyToast({ tone: 'error', title: '请输入密钥值' });
      return;
    }
    setSecretSaving(true);
    try {
      await orbitServerApi.upsertMiniAppSecret(target.appId, cleanName, secretValue.trim());
      setSecretName('');
      setSecretValue('');
      await loadSecrets(target.appId);
      notifyToast({
        tone: 'success',
        title: `已加密保存 ${cleanName}`,
        description: '云函数内可通过 ctx.secrets.get() 读取，数据库以 AES-256-GCM 静态加密存储。',
      });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '保存密钥失败',
        description: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setSecretSaving(false);
    }
  };

  const handleDeleteSecret = async (name: string) => {
    if (!target) return;
    setDeletingSecret(name);
    try {
      await orbitServerApi.deleteMiniAppSecret(target.appId, name);
      await loadSecrets(target.appId);
      notifyToast({ tone: 'info', title: `已删除密钥 ${name}` });
    } catch (err) {
      notifyToast({
        tone: 'error',
        title: '删除密钥失败',
        description: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setDeletingSecret(null);
    }
  };

  const handleRefreshCurrent = () => {
    if (!target) return;
    if (activeTab === 'source') void loadSource(target.appId, target.versionId);
    else if (activeTab === 'secrets') void loadSecrets(target.appId);
    else void loadLogs(target.appId);
  };

  const selectedFile = sourceData?.files.find((f) => f.path === selectedFilePath) ?? null;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="large"
      title={
        target
          ? `托管云函数 · 《${target.appName}》${target.versionLabel ? ` v${target.versionLabel}` : ''}`
          : '托管云函数'
      }
      description={
        target
          ? `应用 ID：${target.appId} · 基于 supabase/edge-runtime 隔离运行，仅作品作者与队长可见`
          : undefined
      }
    >
      <div className={styles.wrap}>
        <div className={styles.topBar}>
          <SegmentedControl
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as FunctionsDialogTab)}
            items={[
              { value: 'source', label: '源码审查' },
              { value: 'secrets', label: `加密密钥 (${secrets.length})` },
              { value: 'logs', label: `调用日志 (${logs.length})` },
            ]}
          />

          <Button
            variant="glass"
            size="small"
            icon={<RefreshCw size={13} />}
            loading={
              (activeTab === 'source' && sourceLoading) ||
              (activeTab === 'secrets' && secretsLoading) ||
              (activeTab === 'logs' && logsLoading)
            }
            onClick={handleRefreshCurrent}
          >
            刷新
          </Button>
        </div>

        {/* 1. 源码审查 */}
        {activeTab === 'source' && (
          <>
            {sourceError && <Message tone="error">{sourceError}</Message>}
            {sourceLoading ? (
              <div className={styles.loadingText}>正在加载云函数包源码…</div>
            ) : !sourceData || !sourceData.hasFunctions ? (
              <Empty
                title="该版本未包含托管云函数"
                description="若需使用 Orbit FaaS，请在构建包根目录新增 functions/ 目录并在 orbit.manifest.json 中声明 cloud.functions 权限与 functions.routes。"
              />
            ) : (
              <>
                <div className={styles.metaRow}>
                  <span className={styles.metaStrong}>已声明路由：</span>
                  {sourceData.routes.map((route) => (
                    <Tag key={route} tone="info">
                      {route}
                    </Tag>
                  ))}
                  <span>
                    超时：{sourceData.timeoutMs ?? 5000}ms · 流式 SSE：
                    {sourceData.allowStreaming ? '已启用' : '关闭'}
                  </span>
                </div>

                <div className={styles.sourceSplit}>
                  <div className={styles.fileList}>
                    {sourceData.files.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`${styles.fileBtn} ${selectedFilePath === file.path ? styles.fileBtnActive : ''}`}
                        onClick={() => setSelectedFilePath(file.path)}
                      >
                        <span className={styles.filePath}>{file.path}</span>
                        <span className={styles.fileSize}>
                          {file.isBinary ? 'WASM 二进制 · ' : ''}
                          {formatBytesCompact(file.sizeBytes)}
                        </span>
                      </button>
                    ))}
                  </div>

                  <div className={styles.codePane}>
                    {selectedFile ? (
                      <>
                        <div className={styles.codeHeader}>
                          <span>functions/{selectedFile.path}</span>
                          <span>{formatBytesCompact(selectedFile.sizeBytes)}</span>
                        </div>
                        {selectedFile.isBinary ? (
                          <div className={styles.binaryNotice}>
                            <Binary size={24} />
                            <strong>WebAssembly 二进制模块（.wasm）</strong>
                            <span>
                              运行在 64MB 内存与无文件系统/无内网隔离的 V8 Isolate 沙箱内，体积{' '}
                              {formatBytesCompact(selectedFile.sizeBytes)}。
                            </span>
                          </div>
                        ) : (
                          <pre className={styles.codePre}>{selectedFile.source ?? ''}</pre>
                        )}
                      </>
                    ) : (
                      <div className={styles.loadingText}>请选择左侧文件查看源码</div>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* 2. 加密环境变量 Secrets */}
        {activeTab === 'secrets' && (
          <>
            <Message tone="info">
              密钥在服务端以 AES-256-GCM 静态加密保存，写入后永不回显明文（队长也仅可看到变量名）。云函数内通过{' '}
              <code>await ctx.secrets.get(&apos;KEY_NAME&apos;)</code> 按需读取。
            </Message>

            <form className={styles.secretForm} onSubmit={handleSaveSecret}>
              <Input
                variant="fill"
                icon={<KeyRound size={14} />}
                placeholder="变量名，如 DEEPSEEK_API_KEY"
                value={secretName}
                onValueChange={(v) => setSecretName(v.toUpperCase())}
              />
              <Input
                variant="fill"
                type="password"
                placeholder="输入密钥明文（同名变量将直接覆盖更新）"
                value={secretValue}
                onValueChange={setSecretValue}
              />
              <Button
                variant="filled"
                size="small"
                type="submit"
                icon={<Plus size={14} />}
                loading={secretSaving}
              >
                加密保存
              </Button>
            </form>

            {secretsError && <Message tone="error">{secretsError}</Message>}

            {secretsLoading ? (
              <div className={styles.loadingText}>正在加载密钥列表…</div>
            ) : secrets.length === 0 ? (
              <Empty
                title="尚未配置加密环境变量"
                description="如需在云函数中隐藏大模型 API Key 或第三方 Webhook 密钥，请在上方添加。"
              />
            ) : (
              <div className={styles.secretList}>
                {secrets.map((sec) => (
                  <div key={sec.name} className={styles.secretItem}>
                    <div className={styles.secretInfo}>
                      <span className={styles.secretName}>{sec.name}</span>
                      <span className={styles.secretMeta}>
                        最近更新：{sec.updatedBy} · {formatTimeCompact(sec.updatedAt)} · 密文托管中
                      </span>
                    </div>
                    <Button
                      variant="glass"
                      size="small"
                      destructive
                      icon={<Trash2 size={13} />}
                      loading={deletingSecret === sec.name}
                      onClick={() => void handleDeleteSecret(sec.name)}
                    >
                      删除
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* 3. 调用日志 */}
        {activeTab === 'logs' && (
          <>
            {logsError && <Message tone="error">{logsError}</Message>}
            {logsLoading ? (
              <div className={styles.loadingText}>正在拉取近期云函数调用日志…</div>
            ) : logs.length === 0 ? (
              <Empty
                title="暂无云函数调用记录"
                description="当应用通过 window.orbitSDK.cloud.call / stream 调用云函数后，最近 200 次调用耗时、状态与 console 输出将自动记录在此。"
              />
            ) : (
              <div className={styles.logList}>
                {logs.map((entry) => (
                  <div key={entry.requestId} className={styles.logItem}>
                    <div className={styles.logHead}>
                      <div className={styles.logLeft}>
                        <Tag tone={entry.status >= 200 && entry.status < 400 ? 'success' : 'warning'}>
                          HTTP {entry.status}
                        </Tag>
                        <span className={styles.logFn}>{entry.fnName}</span>
                        <Tag tone="neutral">{entry.durationMs} ms</Tag>
                      </div>
                      <span className={styles.logMeta}>
                        {formatTimeCompact(entry.createdAt)} · 用户 {entry.userId.slice(0, 10)}
                      </span>
                    </div>

                    {entry.error && <p className={styles.logError}>错误：{entry.error}</p>}

                    {entry.logs.length > 0 && (
                      <div className={styles.consoleBox}>
                        {entry.logs.map((line, idx) => (
                          <div
                            key={`${entry.requestId}-${idx}`}
                            className={`${styles.consoleLine} ${
                              line.level === 'warn'
                                ? styles.consoleWarn
                                : line.level === 'error'
                                  ? styles.consoleError
                                  : ''
                            }`}
                          >
                            [{line.level}] {line.text}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

export const FunctionsBadgeIcon = ShieldCheck;
export const FunctionsLogsIcon = ScrollText;
