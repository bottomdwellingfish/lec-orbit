// 放入 Unity 工程 Assets/Scripts/OrbitSDK.cs（配合 Assets/Plugins/WebGL/OrbitBridge.jslib 使用，SDK v1.3.0）
using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace LecOrbit
{
    public class OrbitSDK : MonoBehaviour
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int Orbit_IsRunningInOrbit();
        [DllImport("__Internal")] private static extern void Orbit_Toast(string msg, string tone);
        [DllImport("__Internal")] private static extern void Orbit_GetCurrentUserAsync(string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_StorageSet(string key, string jsonValue);
        [DllImport("__Internal")] private static extern void Orbit_StorageGetAsync(string key, string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_GetNakamaSessionAsync(string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_ListStudioMembersAsync(int includeSelf, string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_SendRoomInviteAsync(string inputJson, string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_GetLaunchRoomAsync(string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_SubscribeRoomJoin(string goName, string method);
        [DllImport("__Internal")] private static extern void Orbit_SubscribeInviteResponded(string goName, string method);
#endif

        private Action<string> _onUserCallback;
        private Action<string> _onStorageCallback;
        private Action<string> _onNakamaSessionCallback;
        private Action<string> _onStudioMembersCallback;
        private Action<string> _onSendInviteCallback;
        private Action<string> _onLaunchRoomCallback;

        /// <summary>队友点击「接受并进房」触发的冷/热进房事件（载荷为 OrbitRoomJoinPayload JSON）。</summary>
        public event Action<string> OnRoomJoinReceived;

        /// <summary>房主收到的队友接受/婉拒实时回执（载荷为 orbit.invite.responded JSON）。</summary>
        public event Action<string> OnInviteRespondedReceived;

        public static bool IsRunningInOrbit
        {
            get
            {
#if UNITY_WEBGL && !UNITY_EDITOR
                return Orbit_IsRunningInOrbit() == 1;
#else
                return false;
#endif
            }
        }

        public void ShowToast(string message, string tone = "info")
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_Toast(message, tone);
#else
            Debug.Log($"[OrbitSDK.Toast:{tone}] {message}");
#endif
        }

        public void RequestCurrentUser(Action<string> onJsonReceived)
        {
            _onUserCallback = onJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_GetCurrentUserAsync(gameObject.name, nameof(HandleUserJsonReceived));
#else
            onJsonReceived?.Invoke("{\"userId\":\"unity-editor\",\"displayName\":\"Unity 编辑器调试\"}");
#endif
        }

        public void SaveCloudData(string key, string jsonValue)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_StorageSet(key, jsonValue);
#else
            PlayerPrefs.SetString($"orbit_kv_{key}", jsonValue);
#endif
        }

        public void LoadCloudData(string key, Action<string> onJsonReceived)
        {
            _onStorageCallback = onJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_StorageGetAsync(key, gameObject.name, nameof(HandleStorageJsonReceived));
#else
            onJsonReceived?.Invoke(PlayerPrefs.GetString($"orbit_kv_{key}", ""));
#endif
        }

        // ── 多人联机与工作室组队直达进房（SDK v1.3.0+）──

        public void RequestNakamaSession(Action<string> onJsonReceived)
        {
            _onNakamaSessionCallback = onJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_GetNakamaSessionAsync(gameObject.name, nameof(HandleNakamaSessionReceived));
#else
            onJsonReceived?.Invoke("{\"ok\":false,\"error\":\"Unity 编辑器预览无法换取线上 Nakama 凭证\"}");
#endif
        }

        /// <summary>拉取可邀请组队的工作室活跃成员 JSON 数组（正在玩本游戏的同学排在最前）。</summary>
        public void ListStudioMembers(Action<string> onMembersJsonReceived, bool includeSelf = false)
        {
            _onStudioMembersCallback = onMembersJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_ListStudioMembersAsync(includeSelf ? 1 : 0, gameObject.name, nameof(HandleStudioMembersReceived));
#else
            onMembersJsonReceived?.Invoke("[{\"userId\":\"dev-teammate-1\",\"username\":\"teammate1\",\"displayName\":\"测试队友 A\",\"enrollYear\":2025,\"isPlayingThisApp\":true}]");
#endif
        }

        /// <summary>
        /// 向工作室同学发送实时组队邀请。inputJson 示例：
        /// {"toUserIds":["user-id"],"roomId":"match-123","roomName":"1号房","message":"速来开黑","mode":"standalone"}
        /// </summary>
        public void SendRoomInvite(string inputJson, Action<string> onResultJsonReceived = null)
        {
            _onSendInviteCallback = onResultJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_SendRoomInviteAsync(inputJson, gameObject.name, nameof(HandleSendInviteResult));
#else
            Debug.Log($"[OrbitSDK.SendRoomInvite] {inputJson}");
            onResultJsonReceived?.Invoke("{\"ok\":true,\"sent\":[]}");
#endif
        }

        /// <summary>主动拉取冷启动直达房间上下文 JSON（无邀请直达时返回空字符串）。</summary>
        public void RequestLaunchRoom(Action<string> onRoomJsonReceived)
        {
            _onLaunchRoomCallback = onRoomJsonReceived;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_GetLaunchRoomAsync(gameObject.name, nameof(HandleLaunchRoomReceived));
#else
            onRoomJsonReceived?.Invoke("");
#endif
        }

        /// <summary>订阅冷/热直达进房事件（Preload 层会自动缓冲重放早于挂载到达的冷启动邀请）。</summary>
        public void SubscribeRoomJoin(Action<string> handler = null)
        {
            if (handler != null) OnRoomJoinReceived += handler;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_SubscribeRoomJoin(gameObject.name, nameof(HandleRoomJoinEvent));
#endif
        }

        /// <summary>订阅队友接受/婉拒组队邀请的实时回执事件。</summary>
        public void SubscribeInviteResponded(Action<string> handler = null)
        {
            if (handler != null) OnInviteRespondedReceived += handler;
#if UNITY_WEBGL && !UNITY_EDITOR
            Orbit_SubscribeInviteResponded(gameObject.name, nameof(HandleInviteRespondedEvent));
#endif
        }

        private void HandleUserJsonReceived(string json) => _onUserCallback?.Invoke(json);
        private void HandleStorageJsonReceived(string json) => _onStorageCallback?.Invoke(json);
        private void HandleNakamaSessionReceived(string json) => _onNakamaSessionCallback?.Invoke(json);
        private void HandleStudioMembersReceived(string json) => _onStudioMembersCallback?.Invoke(json);
        private void HandleSendInviteResult(string json) => _onSendInviteCallback?.Invoke(json);
        private void HandleLaunchRoomReceived(string json) => _onLaunchRoomCallback?.Invoke(json);
        private void HandleRoomJoinEvent(string json)
        {
            if (!string.IsNullOrEmpty(json)) OnRoomJoinReceived?.Invoke(json);
        }
        private void HandleInviteRespondedEvent(string json)
        {
            if (!string.IsNullOrEmpty(json)) OnInviteRespondedReceived?.Invoke(json);
        }
    }
}
