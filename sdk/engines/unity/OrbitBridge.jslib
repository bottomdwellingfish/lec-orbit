/**
 * Unity WebGL JavaScript Plugin（SDK v1.3.0，放入 Unity 工程 Assets/Plugins/WebGL/OrbitBridge.jslib）
 * 将 window.orbitSDK 桥接至 C#（通过 SendMessage 回调，严格使用 ES5 语法兼容 Emscripten）。
 */
mergeInto(LibraryManager.library, {
  Orbit_IsRunningInOrbit: function () {
    return window.orbitSDK && window.orbitSDK.isOrbit ? 1 : 0;
  },

  Orbit_Toast: function (msgPtr, tonePtr) {
    var msg = UTF8ToString(msgPtr);
    var tone = UTF8ToString(tonePtr) || 'info';
    if (window.orbitSDK && window.orbitSDK.ui) {
      window.orbitSDK.ui.toast(msg, tone);
    }
  },

  Orbit_GetCurrentUserAsync: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.user) {
      SendMessage(go, method, '');
      return;
    }
    window.orbitSDK.user
      .getCurrent()
      .then(function (u) {
        SendMessage(go, method, u ? JSON.stringify(u) : '');
      })
      .catch(function () {
        SendMessage(go, method, '');
      });
  },

  Orbit_StorageSet: function (keyPtr, jsonValuePtr) {
    var key = UTF8ToString(keyPtr);
    var raw = UTF8ToString(jsonValuePtr);
    if (!window.orbitSDK || !window.orbitSDK.storage) return;
    try {
      window.orbitSDK.storage.set(key, JSON.parse(raw));
    } catch (e) {
      window.orbitSDK.storage.set(key, raw);
    }
  },

  Orbit_StorageGetAsync: function (keyPtr, gameObjectPtr, callbackMethodPtr) {
    var key = UTF8ToString(keyPtr);
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.storage) {
      SendMessage(go, method, '');
      return;
    }
    window.orbitSDK.storage
      .get(key)
      .then(function (val) {
        SendMessage(go, method, val === null || val === undefined ? '' : JSON.stringify(val));
      })
      .catch(function () {
        SendMessage(go, method, '');
      });
  },

  // ── 多人联机与工作室组队直达进房（SDK v1.3.0+）──

  Orbit_GetNakamaSessionAsync: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.multiplayer || !window.orbitSDK.multiplayer.getNakamaSession) {
      SendMessage(go, method, JSON.stringify({ ok: false, error: '当前 Orbit 客户端版本不支持 Nakama 换票' }));
      return;
    }
    window.orbitSDK.multiplayer
      .getNakamaSession()
      .then(function (session) {
        SendMessage(go, method, JSON.stringify(session));
      })
      .catch(function (err) {
        SendMessage(go, method, JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
      });
  },

  Orbit_ListStudioMembersAsync: function (includeSelfFlag, gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.multiplayer || !window.orbitSDK.multiplayer.listStudioMembers) {
      SendMessage(go, method, '[]');
      return;
    }
    window.orbitSDK.multiplayer
      .listStudioMembers({ includeSelf: includeSelfFlag === 1 })
      .then(function (list) {
        SendMessage(go, method, JSON.stringify(list || []));
      })
      .catch(function () {
        SendMessage(go, method, '[]');
      });
  },

  Orbit_SendRoomInviteAsync: function (inputJsonPtr, gameObjectPtr, callbackMethodPtr) {
    var rawInput = UTF8ToString(inputJsonPtr);
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.multiplayer || !window.orbitSDK.multiplayer.sendRoomInvite) {
      SendMessage(go, method, JSON.stringify({ ok: false, error: '当前 Orbit 客户端版本不支持组队邀请，请升级至 v0.2.4+' }));
      return;
    }
    var payload;
    try {
      payload = JSON.parse(rawInput);
    } catch (e) {
      SendMessage(go, method, JSON.stringify({ ok: false, error: '邀请参数 JSON 格式非法' }));
      return;
    }
    window.orbitSDK.multiplayer
      .sendRoomInvite(payload)
      .then(function (res) {
        SendMessage(go, method, JSON.stringify(res));
      })
      .catch(function (err) {
        SendMessage(go, method, JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
      });
  },

  Orbit_GetLaunchRoomAsync: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (!window.orbitSDK || !window.orbitSDK.multiplayer || !window.orbitSDK.multiplayer.getLaunchRoom) {
      SendMessage(go, method, '');
      return;
    }
    window.orbitSDK.multiplayer
      .getLaunchRoom()
      .then(function (room) {
        SendMessage(go, method, room ? JSON.stringify(room) : '');
      })
      .catch(function () {
        SendMessage(go, method, '');
      });
  },

  Orbit_SubscribeRoomJoin: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (typeof window.__orbitUnityOffRoomJoin === 'function') {
      window.__orbitUnityOffRoomJoin();
      window.__orbitUnityOffRoomJoin = null;
    }
    if (!window.orbitSDK || !window.orbitSDK.multiplayer || !window.orbitSDK.multiplayer.onRoomJoin) {
      return;
    }
    window.__orbitUnityOffRoomJoin = window.orbitSDK.multiplayer.onRoomJoin(function (payload) {
      SendMessage(go, method, payload ? JSON.stringify(payload) : '');
    });
  },

  Orbit_SubscribeInviteResponded: function (gameObjectPtr, callbackMethodPtr) {
    var go = UTF8ToString(gameObjectPtr);
    var method = UTF8ToString(callbackMethodPtr);
    if (typeof window.__orbitUnityOffInviteResp === 'function') {
      window.__orbitUnityOffInviteResp();
      window.__orbitUnityOffInviteResp = null;
    }
    if (!window.orbitSDK || !window.orbitSDK.realtime || !window.orbitSDK.realtime.onMessage) {
      return;
    }
    window.__orbitUnityOffInviteResp = window.orbitSDK.realtime.onMessage(function (msg) {
      if (msg && msg.event === 'orbit.invite.responded') {
        SendMessage(go, method, JSON.stringify(msg.payload || {}));
      }
    });
  },
});
