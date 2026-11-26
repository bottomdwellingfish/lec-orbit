/** 跨平台周边 Wi-Fi 环境指纹扫描器（仅被动读取附近 802.11 AP 的 BSSID/SSID/RSSI，不依赖 NetBIOS 或局域网防火墙）。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WifiScanOptions, WifiScanResult } from '../../src/shared/ipc';
import {
  aggregateWifiSamples,
  normalizeBssid,
  parseNativeWlanJson,
  parseNetshWlanOutput,
  parseNmcliWifiOutput,
  type RawWifiSample,
} from './wifiParser';

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 20_000;

interface SinglePassResult {
  samples: RawWifiSample[];
  error?: string;
  permissionDenied?: boolean;
}

function buildWindowsNativeWlanScript(triggerScan: boolean, waitMs: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class OrbitWlanScanner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WLAN_INTERFACE_INFO {
    public Guid InterfaceGuid;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
    public string strInterfaceDescription;
    public int isState;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct DOT11_SSID {
    public uint uSSIDLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
    public byte[] ucSSID;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct WLAN_BSS_ENTRY {
    public DOT11_SSID dot11Ssid;
    public uint uPhyId;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
    public byte[] dot11Bssid;
    public int dot11BssType;
    public int dot11BssPhyType;
    public int lRssi;
    public uint uLinkQuality;
    [MarshalAs(UnmanagedType.I1)]
    public bool bInRegDomain;
    public ushort usBeaconPeriod;
    public ulong ullTimestamp;
    public ulong ullHostTimestamp;
    public ushort usCapabilityInformation;
    public uint ulChCenterFrequency;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 126)]
    public ushort[] usRateSet;
    public uint uRateSetLength;
    public uint ulIeOffset;
    public uint ulIeSize;
  }

  [DllImport("wlanapi.dll")]
  static extern uint WlanOpenHandle(uint dwClientVersion, IntPtr pReserved, out uint pdwNegotiatedVersion, out IntPtr phClientHandle);
  [DllImport("wlanapi.dll")]
  static extern uint WlanCloseHandle(IntPtr hClientHandle, IntPtr pReserved);
  [DllImport("wlanapi.dll")]
  static extern uint WlanEnumInterfaces(IntPtr hClientHandle, IntPtr pReserved, out IntPtr ppInterfaceList);
  [DllImport("wlanapi.dll")]
  static extern uint WlanScan(IntPtr hClientHandle, ref Guid pInterfaceGuid, IntPtr pDot11Ssid, IntPtr pIeData, IntPtr pReserved);
  [DllImport("wlanapi.dll")]
  static extern uint WlanGetNetworkBssList(IntPtr hClientHandle, ref Guid pInterfaceGuid, IntPtr pDot11Ssid, int dot11BssType, bool bSecurityEnabled, IntPtr pReserved, out IntPtr ppWlanBssList);
  [DllImport("wlanapi.dll")]
  static extern void WlanFreeMemory(IntPtr pMemory);

  public static string Scan(bool triggerScan, int waitMs) {
    uint negVer;
    IntPtr handle = IntPtr.Zero;
    uint rc = WlanOpenHandle(2, IntPtr.Zero, out negVer, out handle);
    if (rc != 0) return "{\\"ok\\":false,\\"code\\":" + rc + ",\\"stage\\":\\"open\\",\\"networks\\":[]}";
    IntPtr ifaceListPtr = IntPtr.Zero;
    try {
      rc = WlanEnumInterfaces(handle, IntPtr.Zero, out ifaceListPtr);
      if (rc != 0 || ifaceListPtr == IntPtr.Zero) return "{\\"ok\\":false,\\"code\\":" + rc + ",\\"stage\\":\\"enum\\",\\"networks\\":[]}";
      int ifaceCount = Marshal.ReadInt32(ifaceListPtr, 0);
      if (ifaceCount <= 0) return "{\\"ok\\":false,\\"code\\":0,\\"stage\\":\\"no_interface\\",\\"networks\\":[]}";
      int ifaceSize = Marshal.SizeOf(typeof(WLAN_INTERFACE_INFO));
      var guids = new List<Guid>();
      for (int i = 0; i < ifaceCount; i++) {
        IntPtr itemPtr = new IntPtr(ifaceListPtr.ToInt64() + 8 + i * ifaceSize);
        var info = (WLAN_INTERFACE_INFO)Marshal.PtrToStructure(itemPtr, typeof(WLAN_INTERFACE_INFO));
        guids.Add(info.InterfaceGuid);
      }
      uint lastErr = 0;
      if (triggerScan) {
        foreach (var g in guids) {
          var gg = g;
          uint sr = WlanScan(handle, ref gg, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
          if (sr != 0) lastErr = sr;
        }
        if (waitMs > 0) Thread.Sleep(waitMs);
      }
      var sb = new StringBuilder();
      sb.Append("{\\"ok\\":true,\\"code\\":0,\\"networks\\":[");
      bool first = true;
      bool anyListOk = false;
      foreach (var g in guids) {
        var gg = g;
        IntPtr bssListPtr = IntPtr.Zero;
        uint br = WlanGetNetworkBssList(handle, ref gg, IntPtr.Zero, 3, false, IntPtr.Zero, out bssListPtr);
        if (br != 0 || bssListPtr == IntPtr.Zero) {
          if (br != 0) lastErr = br;
          continue;
        }
        anyListOk = true;
        try {
          int numItems = Marshal.ReadInt32(bssListPtr, 4);
          int entrySize = Marshal.SizeOf(typeof(WLAN_BSS_ENTRY));
          for (int i = 0; i < numItems; i++) {
            IntPtr entryPtr = new IntPtr(bssListPtr.ToInt64() + 8 + i * entrySize);
            var entry = (WLAN_BSS_ENTRY)Marshal.PtrToStructure(entryPtr, typeof(WLAN_BSS_ENTRY));
            string bssid = string.Format("{0:x2}:{1:x2}:{2:x2}:{3:x2}:{4:x2}:{5:x2}",
              entry.dot11Bssid[0], entry.dot11Bssid[1], entry.dot11Bssid[2],
              entry.dot11Bssid[3], entry.dot11Bssid[4], entry.dot11Bssid[5]);
            int ssidLen = (int)Math.Min(entry.dot11Ssid.uSSIDLength, 32u);
            string ssid = ssidLen > 0 ? Encoding.UTF8.GetString(entry.dot11Ssid.ucSSID, 0, ssidLen) : "";
            string escSsid = ssid.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", "").Replace("\\n", "");
            if (!first) sb.Append(",");
            first = false;
            sb.Append("{\\"bssid\\":\\"").Append(bssid).Append("\\",\\"ssid\\":\\"").Append(escSsid).Append("\\",\\"rssi\\":").Append(entry.lRssi).Append("}");
          }
        } finally {
          WlanFreeMemory(bssListPtr);
        }
      }
      sb.Append("]}");
      if (!anyListOk && lastErr != 0) return "{\\"ok\\":false,\\"code\\":" + lastErr + ",\\"stage\\":\\"bss\\",\\"networks\\":[]}";
      return sb.ToString();
    } finally {
      if (ifaceListPtr != IntPtr.Zero) WlanFreeMemory(ifaceListPtr);
      if (handle != IntPtr.Zero) WlanCloseHandle(handle, IntPtr.Zero);
    }
  }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[OrbitWlanScanner]::Scan(${triggerScan ? '$true' : '$false'}, ${Math.max(0, Math.min(3000, waitMs))})
`;
}

const MAC_COREWLAN_JXA = `
ObjC.import("CoreWLAN");
var client = $.CWWiFiClient.sharedWiFiClient;
var iface = client.interface;
if (!iface || iface.isNil()) {
  JSON.stringify({ ok: false, reason: "no_interface", total: 0, networks: [] });
} else {
  var err = Ref();
  var nets = iface.scanForNetworksWithNameError($(), err);
  var out = [];
  if (nets && !nets.isNil()) {
    var arr = nets.allObjects;
    var count = arr.count;
    for (var i = 0; i < count; i++) {
      var n = arr.objectAtIndex(i);
      var bssid = n.bssid && !n.bssid.isNil() ? ObjC.unwrap(n.bssid) : "";
      var ssid = n.ssid && !n.ssid.isNil() ? ObjC.unwrap(n.ssid) : "";
      var rssi = Number(n.rssiValue);
      out.push({ bssid: bssid, ssid: ssid, rssi: isNaN(rssi) ? -75 : rssi });
    }
    JSON.stringify({ ok: true, reason: "", total: out.length, networks: out });
  } else {
    var errMsg = err[0] && !err[0].isNil() ? ObjC.unwrap(err[0].localizedDescription) : "scan_failed";
    JSON.stringify({ ok: false, reason: errMsg, total: 0, networks: [] });
  }
}
`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanWindowsNetshOnce(): Promise<SinglePassResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'cmd.exe',
      ['/d', '/s', '/c', 'chcp 65001 >nul && netsh wlan show networks mode=bssid'],
      {
        timeout: 8_000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const combined = `${stdout ?? ''}\n${stderr ?? ''}`;
    const samples = parseNetshWlanOutput(stdout ?? '');
    if (samples.length > 0) {
      return { samples };
    }
    if (/location|位置|privacy|隐私|permission|拒绝访问/i.test(combined)) {
      return {
        samples: [],
        permissionDenied: true,
        error: 'Windows 定位权限未开启，系统阻止读取周边 Wi-Fi 列表：请在「设置 → 隐私和安全性 → 位置」中开启定位服务与桌面应用访问权限后重试。',
      };
    }
    if (/wlan autoconfig|无线自动配置|wlansvc|not running|未运行/i.test(combined)) {
      return {
        samples: [],
        error: '当前设备未启用无线网络服务（WLAN AutoConfig），或台式机未安装无线网卡。',
      };
    }
    if (/no wireless interface|没有无线接口|powered down|已关闭/i.test(combined)) {
      return {
        samples: [],
        error: '未检测到开启状态的 Wi-Fi 网卡，请打开本机 Wi-Fi 开关（无需连接任何热点）后重试。',
      };
    }
    return {
      samples: [],
      error: '未扫描到周边 Wi-Fi 信号，请确认本机 Wi-Fi 开关已开启。',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/location|位置|privacy|隐私/i.test(msg)) {
      return {
        samples: [],
        permissionDenied: true,
        error: 'Windows 定位权限未开启，系统阻止读取周边 Wi-Fi 列表：请在「设置 → 隐私和安全性 → 位置」中开启定位权限后重试。',
      };
    }
    return {
      samples: [],
      error: `读取周边 Wi-Fi 信号失败：${msg}`,
    };
  }
}

async function scanWindowsOnce(force: boolean): Promise<SinglePassResult> {
  try {
    const psScript = buildWindowsNativeWlanScript(force, force ? 1200 : 0);
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        timeout: 12_000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const parsed = parseNativeWlanJson(stdout ?? '');
    if (parsed.ok && parsed.samples.length > 0) {
      return { samples: parsed.samples };
    }
    if (!parsed.shouldFallback && parsed.error) {
      return {
        samples: [],
        error: parsed.error,
        permissionDenied: parsed.permissionDenied,
      };
    }
  } catch {
    // 兼容受限 PowerShell 环境，自动回退 netsh
  }
  return scanWindowsNetshOnce();
}

async function scanMacOnce(): Promise<SinglePassResult> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_COREWLAN_JXA], {
      timeout: 12_000,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse((stdout ?? '').trim()) as {
      ok?: boolean;
      reason?: string;
      total?: number;
      networks?: Array<{ bssid?: string; ssid?: string; rssi?: number }>;
    };

    if (!parsed.ok) {
      if (parsed.reason === 'no_interface') {
        return {
          samples: [],
          error: '未检测到可用 Wi-Fi 网卡，请确认已打开 Mac 的 Wi-Fi 开关。',
        };
      }
      return {
        samples: [],
        error: `macOS Wi-Fi 扫描失败：${parsed.reason || '未知错误'}`,
      };
    }

    const rawNetworks = Array.isArray(parsed.networks) ? parsed.networks : [];
    const samples: RawWifiSample[] = [];
    for (const item of rawNetworks) {
      const bssid = typeof item.bssid === 'string' ? normalizeBssid(item.bssid) : null;
      if (!bssid) continue;
      samples.push({
        bssid,
        ssid: typeof item.ssid === 'string' ? item.ssid.trim() : '',
        rssi: typeof item.rssi === 'number' && Number.isFinite(item.rssi) ? item.rssi : -75,
      });
    }

    if (samples.length === 0 && (parsed.total ?? rawNetworks.length) > 0) {
      return {
        samples: [],
        permissionDenied: true,
        error:
          '已检测到周边 Wi-Fi，但 macOS 隐私策略隐藏了路由器 BSSID：请在「系统设置 → 隐私与安全性 → 定位服务」中开启 Orbit 的定位权限后重试。',
      };
    }

    if (samples.length === 0) {
      return {
        samples: [],
        error: '未扫描到周边 Wi-Fi 信号，请确认 Mac 的 Wi-Fi 已开启。',
      };
    }

    return { samples };
  } catch (err) {
    return {
      samples: [],
      error: `macOS Wi-Fi 扫描异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function scanLinuxOnce(force: boolean): Promise<SinglePassResult> {
  const args = force
    ? ['--rescan', 'yes', '-t', '-f', 'BSSID,SSID,SIGNAL', 'dev', 'wifi', 'list']
    : ['-t', '-f', 'BSSID,SSID,SIGNAL', 'dev', 'wifi', 'list'];
  try {
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync('nmcli', args, {
        timeout: 10_000,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      }));
    } catch (rescanErr) {
      if (!force) throw rescanErr;
      ({ stdout } = await execFileAsync(
        'nmcli',
        ['-t', '-f', 'BSSID,SSID,SIGNAL', 'dev', 'wifi', 'list'],
        {
          timeout: 8_000,
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024,
        },
      ));
    }
    const samples = parseNmcliWifiOutput(stdout ?? '');
    if (samples.length === 0) {
      return {
        samples: [],
        error: '未通过 nmcli 扫描到周边 Wi-Fi 信号，请确认无线网卡已开启。',
      };
    }
    return { samples };
  } catch (err) {
    return {
      samples: [],
      error: `Linux Wi-Fi 扫描失败（需安装 NetworkManager/nmcli）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runSinglePlatformScan(force: boolean): Promise<SinglePassResult> {
  if (process.platform === 'win32') return scanWindowsOnce(force);
  if (process.platform === 'darwin') return scanMacOnce();
  if (process.platform === 'linux') return scanLinuxOnce(force);
  return {
    samples: [],
    error: `当前操作系统（${process.platform}）暂不支持周边 Wi-Fi 指纹扫描。`,
  };
}

let cachedResult: WifiScanResult | null = null;
let inFlightSingleScan: Promise<WifiScanResult> | null = null;

/**
 * 扫描周边 Wi-Fi BSSID 与信号强度。
 * - 默认单次扫描并缓存 20 秒，避免轮询频繁唤醒无线扫描；
 * - 签到/签退时传 `force: true` 实时刷新；
 * - 队长采集工作室指纹基线时传 `samples: 3, force: true` 连续采集 3 轮并聚合稳定性。
 */
export async function scanNearbyWifi(options?: WifiScanOptions): Promise<WifiScanResult> {
  const samplesCount = Math.max(1, Math.min(5, Math.floor(options?.samples ?? 1)));
  const force = Boolean(options?.force) || samplesCount > 1;

  if (!force && cachedResult && Date.now() - cachedResult.scannedAt < CACHE_TTL_MS) {
    return cachedResult;
  }

  if (samplesCount === 1 && !force && inFlightSingleScan) {
    return inFlightSingleScan;
  }

  const task = (async (): Promise<WifiScanResult> => {
    const rounds: RawWifiSample[][] = [];
    let lastError: string | undefined;
    let permissionDenied = false;

    for (let i = 0; i < samplesCount; i++) {
      const pass = await runSinglePlatformScan(force);
      if (pass.samples.length > 0) {
        rounds.push(pass.samples);
      } else if (pass.error) {
        lastError = pass.error;
        if (pass.permissionDenied) permissionDenied = true;
      }
      if (i + 1 < samplesCount) {
        await delay(process.platform === 'darwin' ? 450 : 850);
      }
    }

    const networks = rounds.length > 0 ? aggregateWifiSamples(rounds) : [];
    const result: WifiScanResult = {
      ok: networks.length > 0,
      platform: process.platform,
      scannedAt: Date.now(),
      rounds: samplesCount,
      networks,
      error: networks.length > 0 ? undefined : lastError || '未扫描到可用周边 Wi-Fi 信号。',
      ...(networks.length === 0 && permissionDenied ? { permissionDenied: true } : {}),
    };

    if (result.ok) {
      cachedResult = result;
    }
    return result;
  })();

  if (samplesCount === 1 && !force) {
    inFlightSingleScan = task.finally(() => {
      inFlightSingleScan = null;
    });
    return inFlightSingleScan;
  }

  return task;
}
