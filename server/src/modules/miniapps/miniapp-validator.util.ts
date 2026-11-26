/**
 * 工坊小程序 / 小游戏 ZIP 构建包与 Manifest 安全校验器：
 * - 等价迁移原 Go 版 internal/miniapp/validator.go；
 * - 防 Zip Bomb（压缩包 <=100MB，解压总计 <=250MB，文件数 <=5000）、防路径穿越、防符号链接；
 * - 完整支持全新极简交易权限作用域：economy.read / economy.wager.coin / economy.wager.punch / economy.tip。
 */
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import yauzl, { type Entry } from 'yauzl';
import { detectImageType } from '../announcements/announcements.service.js';
import type { StoredFunctionFile } from '../functions/entities/functions.entities.js';
import { scanFunctionSourceSafety } from '../functions/functions-context.util.js';

export const MINIAPP_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const MINIAPP_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;
export const MINIAPP_MAX_FILE_COUNT = 5000;
export const MINIAPP_MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MINIAPP_MAX_FN_FILE_COUNT = 32;
export const MINIAPP_MAX_FN_SINGLE_BYTES = 2 * 1024 * 1024;
export const MINIAPP_MAX_FN_TOTAL_BYTES = 5 * 1024 * 1024;

const APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FN_ROUTE_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;
const FN_ALLOWED_EXTS = new Set(['.ts', '.js', '.mjs', '.json', '.wasm']);
const FN_CODE_EXTS = new Set(['.ts', '.js', '.mjs']);

const VALID_TYPES = new Set(['miniapp', 'minigame']);
const VALID_ENGINES = new Set(['web', 'cocos', 'unity', 'godot', 'other']);
const VALID_MODES = new Set(['sidepanel', 'workspace', 'standalone']);
const VALID_SCOPES = new Set([
  'user.profile',
  'storage.cloud',
  'clipboard',
  'economy.read',
  'economy.wager.coin',
  'economy.wager.punch',
  'economy.tip',
  'cloud.functions',
  'realtime.room',
]);

export interface MiniAppFunctionsManifest {
  dir: string;
  timeoutMs: number;
  allowStreaming: boolean;
  routes: string[];
}

export interface ExtractedFunctionBundle {
  routes: string[];
  files: StoredFunctionFile[];
  timeoutMs: number;
  allowStreaming: boolean;
  sha256: string;
}

export interface MiniAppManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  type: string;
  engine: string;
  entry: string;
  icon?: string;
  description: string;
  tags: string[];
  window: {
    defaultMode: string;
    supportedModes: string[];
    sidepanelWidth: number;
    width: number;
    height: number;
    resizable: boolean;
    aspectRatio?: string;
    allowFullscreen: boolean;
  };
  runtime: {
    crossOriginIsolated: boolean;
    isolationPolicy: string;
    pointerLock: boolean;
    gamepad: boolean;
    minOrbitVersion?: string;
  };
  permissions: {
    scopes: string[];
    networkDomains: string[];
  };
  functions?: MiniAppFunctionsManifest;
}

export interface ValidatedZipBundle {
  manifest: MiniAppManifest;
  sha256: string;
  compressedBytes: number;
  uncompressedBytes: number;
  fileCount: number;
  iconBytes?: Buffer;
  iconContentType?: string;
  iconExt?: string;
  functionBundle?: ExtractedFunctionBundle;
}

/** 规范化并校验 orbit.manifest.json 内容，不合法抛出中文错误。 */
export function normalizeAndValidateManifest(raw: Partial<MiniAppManifest>): MiniAppManifest {
  const schemaVersion = raw.schemaVersion === undefined || raw.schemaVersion === 0 ? 1 : raw.schemaVersion;
  if (schemaVersion !== 1) {
    throw new Error(`不支持的 manifest schemaVersion: ${schemaVersion}`);
  }
  const id = (raw.id ?? '').trim();
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error('应用 ID 非法（需为 2~64 位小写字母、数字与短横线）');
  }
  const name = (raw.name ?? '').trim();
  if (!name || [...name].length > 48) {
    throw new Error('应用名称不能为空且不超过 48 字');
  }
  const version = (raw.version ?? '').trim();
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error('版本号需符合 SemVer（如 1.0.0）');
  }
  const type = (raw.type ?? '').trim() || 'miniapp';
  if (!VALID_TYPES.has(type)) {
    throw new Error('应用类型仅支持 miniapp 或 minigame');
  }
  const engine = (raw.engine ?? '').trim() || 'web';
  if (!VALID_ENGINES.has(engine)) {
    throw new Error(`引擎类型不支持：${engine}`);
  }

  let entry = (raw.entry ?? '').trim().replace(/^\.\//, '');
  if (!entry) entry = 'index.html';
  if (entry.startsWith('/') || entry.includes('..')) {
    throw new Error(`入口文件路径非法：${entry}`);
  }

  let icon = raw.icon ? raw.icon.trim().replace(/^\.\//, '') : undefined;
  if (icon && (icon.startsWith('/') || icon.includes('..'))) {
    throw new Error(`图标路径非法：${icon}`);
  }
  if (!icon) icon = undefined;

  const description = (raw.description ?? '').trim();
  if ([...description].length > 400) {
    throw new Error('应用简介不能超过 400 字');
  }

  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 8)
    : [];

  const rawWin = raw.window ?? ({} as Partial<MiniAppManifest['window']>);
  const defaultMode = rawWin.defaultMode || (type === 'minigame' ? 'standalone' : 'workspace');
  if (!VALID_MODES.has(defaultMode)) {
    throw new Error(`无效的默认窗口形态：${defaultMode}`);
  }
  const supportedModes =
    Array.isArray(rawWin.supportedModes) && rawWin.supportedModes.length > 0
      ? rawWin.supportedModes
      : ['sidepanel', 'workspace', 'standalone'];
  for (const m of supportedModes) {
    if (!VALID_MODES.has(m)) throw new Error(`无效的支持窗口形态：${m}`);
  }

  const sidepanelWidth =
    rawWin.sidepanelWidth && rawWin.sidepanelWidth >= 320 && rawWin.sidepanelWidth <= 640
      ? rawWin.sidepanelWidth
      : 400;
  const width =
    rawWin.width && rawWin.width >= 360 && rawWin.width <= 2560 ? rawWin.width : 1120;
  const height =
    rawWin.height && rawWin.height >= 480 && rawWin.height <= 1600 ? rawWin.height : 720;

  const rawRt = raw.runtime ?? ({} as Partial<MiniAppManifest['runtime']>);
  const isolationPolicy = rawRt.isolationPolicy || 'credentialless';
  if (isolationPolicy !== 'credentialless' && isolationPolicy !== 'require-corp') {
    throw new Error(`无效的 isolationPolicy：${isolationPolicy}`);
  }

  const rawPerms = raw.permissions ?? ({} as Partial<MiniAppManifest['permissions']>);
  const scopes = Array.isArray(rawPerms.scopes)
    ? rawPerms.scopes
    : ['user.profile', 'storage.cloud'];
  for (const sc of scopes) {
    if (!VALID_SCOPES.has(sc)) {
      throw new Error(`不支持的权限范围：${sc}`);
    }
  }
  const networkDomains = Array.isArray(rawPerms.networkDomains) ? rawPerms.networkDomains : [];
  if (networkDomains.length > 16) {
    throw new Error('networkDomains 最多声明 16 个域名');
  }

  let functionsConfig: MiniAppFunctionsManifest | undefined;
  if (raw.functions !== undefined && raw.functions !== null) {
    if (typeof raw.functions !== 'object') {
      throw new Error('manifest.functions 必须是对象配置');
    }
    const rawFn = raw.functions as Partial<MiniAppFunctionsManifest>;
    const dir = (rawFn.dir ?? 'functions').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!dir || dir.startsWith('/') || dir.includes('..') || dir.includes('\\')) {
      throw new Error(`云函数目录路径非法：${rawFn.dir}`);
    }
    const routes = Array.isArray(rawFn.routes)
      ? Array.from(
          new Set(
            rawFn.routes
              .filter((r): r is string => typeof r === 'string')
              .map((r) => r.trim())
              .filter(Boolean),
          ),
        )
      : [];
    if (routes.length === 0 || routes.length > 16) {
      throw new Error('manifest.functions.routes 需声明 1~16 个云函数路由名');
    }
    for (const r of routes) {
      if (!FN_ROUTE_PATTERN.test(r)) {
        throw new Error(`云函数路由名非法（仅支持字母、数字、下划线与短横线）：${r}`);
      }
    }
    const allowStreaming = Boolean(rawFn.allowStreaming);
    const maxTimeout = allowStreaming ? 60_000 : 10_000;
    const defaultTimeout = allowStreaming ? 30_000 : 5_000;
    const rawTimeout = typeof rawFn.timeoutMs === 'number' && Number.isFinite(rawFn.timeoutMs)
      ? Math.floor(rawFn.timeoutMs)
      : defaultTimeout;
    const timeoutMs = Math.min(Math.max(rawTimeout, 1_000), maxTimeout);
    if (!scopes.includes('cloud.functions')) {
      throw new Error('声明了 manifest.functions 时，必须在 permissions.scopes 中添加 cloud.functions');
    }
    functionsConfig = {
      dir,
      timeoutMs,
      allowStreaming,
      routes,
    };
  }

  return {
    schemaVersion,
    id,
    name,
    version,
    type,
    engine,
    entry,
    ...(icon ? { icon } : {}),
    description,
    tags,
    window: {
      defaultMode,
      supportedModes,
      sidepanelWidth,
      width,
      height,
      resizable: rawWin.resizable ?? true,
      ...(rawWin.aspectRatio ? { aspectRatio: rawWin.aspectRatio } : {}),
      allowFullscreen: rawWin.allowFullscreen ?? true,
    },
    runtime: {
      crossOriginIsolated: Boolean(rawRt.crossOriginIsolated),
      isolationPolicy,
      pointerLock: Boolean(rawRt.pointerLock),
      gamepad: rawRt.gamepad ?? true,
      ...(rawRt.minOrbitVersion ? { minOrbitVersion: rawRt.minOrbitVersion } : {}),
    },
    permissions: {
      scopes,
      networkDomains,
    },
    ...(functionsConfig ? { functions: functionsConfig } : {}),
  };
}

function normalizeZipEntryPath(raw: string): string {
  const replaced = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!replaced || replaced.includes('\0')) {
    throw new Error('压缩包包含非法空路径');
  }
  if (replaced.startsWith('/')) {
    throw new Error(`压缩包禁止包含绝对路径：${raw}`);
  }
  if (replaced.length >= 2 && replaced[1] === ':') {
    throw new Error(`压缩包禁止包含盘符路径：${raw}`);
  }
  for (const seg of replaced.split('/')) {
    if (seg === '..') {
      throw new Error(`检测到路径穿越风险条目：${raw}`);
    }
  }
  return replaced;
}

function readZipEntryBuffer(zipfile: yauzl.ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('无法读取压缩包条目'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          reject(new Error('文件体积超限'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/** 校验上传的 ZIP/.lecapp 构建包安全性与 orbit.manifest.json 合规性。 */
export function validateZipBundle(data: Buffer): Promise<ValidatedZipBundle> {
  if (data.length > MINIAPP_MAX_BUNDLE_BYTES) {
    return Promise.reject(new Error('构建包超过 100MB 上限，请改用 GitHub Releases 导入方式'));
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, decodeStrings: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(new Error(`无效的 ZIP 压缩包：${openErr?.message ?? '无法解析'}`));
        return;
      }

      const files: Array<{ entry: Entry; name: string }> = [];
      let totalUncompressed = 0;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        reject(err);
      };

      zipfile.on('error', (err) => {
        if (/relative path|absolute path|\.\./i.test(err.message)) {
          fail(new Error(`检测到路径穿越或非法路径条目：${err.message}`));
          return;
        }
        fail(new Error(`无效的 ZIP 压缩包：${err.message}`));
      });
      zipfile.on('entry', (entry: Entry) => {
        const rawName = entry.fileName;
        if (
          rawName.startsWith('__MACOSX/') ||
          rawName === '__MACOSX' ||
          rawName.endsWith('/.DS_Store') ||
          rawName === '.DS_Store'
        ) {
          zipfile.readEntry();
          return;
        }

        let norm: string;
        try {
          norm = normalizeZipEntryPath(rawName);
        } catch (err) {
          fail(err as Error);
          return;
        }

        if (norm.endsWith('/')) {
          zipfile.readEntry();
          return;
        }

        // 检测 Unix 符号链接（externalFileAttributes 高 16 位为 POSIX mode）
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixMode === 0o120000) {
          fail(new Error(`安全校验失败：压缩包禁止包含符号链接 (${rawName})`));
          return;
        }

        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > MINIAPP_MAX_UNCOMPRESSED_BYTES) {
          fail(new Error('解压总体积超过 250MB 安全上限'));
          return;
        }
        files.push({ entry, name: norm });
        if (files.length > MINIAPP_MAX_FILE_COUNT) {
          fail(new Error(`压缩包文件数量超过 ${MINIAPP_MAX_FILE_COUNT} 上限`));
          return;
        }
        zipfile.readEntry();
      });

      zipfile.on('end', () => {
        void (async () => {
          try {
            if (files.length === 0) {
              throw new Error('压缩包内没有任何文件');
            }

            // 自动剥离单层外包目录（如 macOS 打包产生的 my-app/orbit.manifest.json）
            let stripPrefix = '';
            const hasRootManifest = files.some((f) => f.name === 'orbit.manifest.json');
            if (!hasRootManifest) {
              const nested = files.filter((f) => f.name.endsWith('/orbit.manifest.json'));
              if (nested.length === 1) {
                const candidate = nested[0].name.slice(0, -'orbit.manifest.json'.length);
                if (files.every((f) => f.name.startsWith(candidate))) {
                  stripPrefix = candidate;
                }
              }
            }

            const fileMap = new Map<string, Entry>();
            for (const f of files) {
              fileMap.set(f.name.slice(stripPrefix.length), f.entry);
            }

            const manifestEntry = fileMap.get('orbit.manifest.json');
            if (!manifestEntry) {
              throw new Error('压缩包根目录缺少 orbit.manifest.json');
            }
            const manifestBuf = await readZipEntryBuffer(zipfile, manifestEntry, 512 * 1024);
            let parsedRaw: Partial<MiniAppManifest>;
            try {
              parsedRaw = JSON.parse(manifestBuf.toString('utf8')) as Partial<MiniAppManifest>;
            } catch (err) {
              throw new Error(
                `orbit.manifest.json JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }

            const manifest = normalizeAndValidateManifest(parsedRaw);
            if (!fileMap.has(manifest.entry)) {
              throw new Error(`压缩包缺少清单声明的入口文件：${manifest.entry}`);
            }

            const result: ValidatedZipBundle = {
              manifest,
              sha256: createHash('sha256').update(data).digest('hex'),
              compressedBytes: data.length,
              uncompressedBytes: totalUncompressed,
              fileCount: files.length,
            };

            // 可选提取应用图标
            if (manifest.icon && fileMap.has(manifest.icon)) {
              try {
                const iconBuf = await readZipEntryBuffer(
                  zipfile,
                  fileMap.get(manifest.icon)!,
                  MINIAPP_MAX_ICON_BYTES,
                );
                if (iconBuf.length > 0) {
                  if (extname(manifest.icon).toLowerCase() === '.svg') {
                    result.iconBytes = iconBuf;
                    result.iconContentType = 'image/svg+xml';
                    result.iconExt = '.svg';
                  } else {
                    const detected = detectImageType(iconBuf);
                    if (detected && detected.contentType !== 'image/gif') {
                      result.iconBytes = iconBuf;
                      result.iconContentType = detected.contentType;
                      result.iconExt = detected.ext;
                    }
                  }
                }
              } catch {
                // 图标提取失败不阻塞包上传
              }
            }

            // 可选提取并静态安全扫描 Orbit 托管云函数目录（支持 .ts/.js/.mjs/.json/.wasm）
            if (manifest.functions) {
              const fnPrefix = `${manifest.functions.dir}/`;
              const fnEntries: Array<{ relPath: string; entry: Entry }> = [];
              for (const [path, entry] of fileMap.entries()) {
                if (!path.startsWith(fnPrefix)) continue;
                const relPath = path.slice(fnPrefix.length);
                if (!relPath || relPath.startsWith('.') || relPath.includes('/.')) continue;
                const ext = extname(relPath).toLowerCase();
                if (!FN_ALLOWED_EXTS.has(ext)) {
                  throw new Error(
                    `云函数目录包含不支持的文件类型（${path}），仅允许 .ts / .js / .mjs / .json / .wasm`,
                  );
                }
                fnEntries.push({ relPath, entry });
              }

              if (fnEntries.length === 0) {
                throw new Error(`manifest.functions 声明的目录 ${manifest.functions.dir}/ 为空`);
              }
              if (fnEntries.length > MINIAPP_MAX_FN_FILE_COUNT) {
                throw new Error(`云函数文件数超过上限（最多 ${MINIAPP_MAX_FN_FILE_COUNT} 个文件）`);
              }

              fnEntries.sort((a, b) => a.relPath.localeCompare(b.relPath));

              // 校验每个声明的路由都有对应的入口源码文件
              const relSet = new Set(fnEntries.map((f) => f.relPath));
              for (const route of manifest.functions.routes) {
                const hasEntry =
                  relSet.has(`${route}.ts`) ||
                  relSet.has(`${route}.js`) ||
                  relSet.has(`${route}.mjs`);
                if (!hasEntry) {
                  throw new Error(
                    `云函数路由 "${route}" 缺少入口文件（需提供 ${manifest.functions.dir}/${route}.ts 或 .js/.mjs）`,
                  );
                }
              }

              const storedFiles: StoredFunctionFile[] = [];
              let fnTotalBytes = 0;
              const bundleHash = createHash('sha256');
              for (const item of fnEntries) {
                const buf = await readZipEntryBuffer(zipfile, item.entry, MINIAPP_MAX_FN_SINGLE_BYTES);
                fnTotalBytes += buf.length;
                if (fnTotalBytes > MINIAPP_MAX_FN_TOTAL_BYTES) {
                  throw new Error('云函数目录总体积超过 5MB 上限');
                }
                const ext = extname(item.relPath).toLowerCase();
                const isBinary = ext === '.wasm';
                if (FN_CODE_EXTS.has(ext)) {
                  scanFunctionSourceSafety(buf.toString('utf8'), `${manifest.functions.dir}/${item.relPath}`);
                }
                const contentBase64 = buf.toString('base64');
                bundleHash.update(item.relPath).update('\0').update(buf).update('\0');
                storedFiles.push({
                  path: item.relPath,
                  contentBase64,
                  isBinary,
                  sizeBytes: buf.length,
                });
              }

              result.functionBundle = {
                routes: manifest.functions.routes,
                files: storedFiles,
                timeoutMs: manifest.functions.timeoutMs,
                allowStreaming: manifest.functions.allowStreaming,
                sha256: bundleHash.digest('hex'),
              };
            }

            if (!settled) {
              settled = true;
              zipfile.close();
              resolve(result);
            }
          } catch (err) {
            fail(err as Error);
          }
        })();
      });

      zipfile.readEntry();
    });
  });
}

/** 校验 GitHub Releases 大包导入地址合法性。 */
export function isAllowedGitHubReleaseUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'objects.githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}
