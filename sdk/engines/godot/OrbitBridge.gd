# 放入 Godot 4 工程并配置为 Autoload 单例（名称：OrbitBridge，适配 SDK v1.3.0）
# 说明：若导出 preset 开启了「Thread Support」，请在 orbit.manifest.json 中设置
# runtime.crossOriginIsolated = true，Orbit 会自动注入 COOP/COEP 启用 SharedArrayBuffer。
extends Node

signal user_loaded(user_dict: Dictionary)
signal storage_loaded(key: String, value: Variant)
signal theme_changed(theme: String)
signal nakama_session_loaded(session_dict: Dictionary)
signal studio_members_loaded(members: Array)
signal room_invite_sent(result: Dictionary)
signal room_join_received(payload: Dictionary)
signal invite_responded(payload: Dictionary)

var _is_web: bool = OS.has_feature("web")
var _user_cb_ref
var _theme_cb_ref
var _nakama_cb_ref
var _members_cb_ref
var _invite_cb_ref
var _launch_room_cb_ref
var _room_join_cb_ref
var _invite_resp_cb_ref

func _ready() -> void:
	if not _is_web or not is_in_orbit():
		return
	var win := JavaScriptBridge.get_interface("window")

	_theme_cb_ref = JavaScriptBridge.create_callback(_on_js_theme_changed)
	win.__orbitGdThemeCb = _theme_cb_ref
	JavaScriptBridge.eval("window.orbitSDK?.env?.onThemeChange?.((t) => window.__orbitGdThemeCb(String(t)))")

	# 订阅冷/热直达进房事件（Preload 层会自动缓冲重放早于 _ready 到达的冷启动邀请）
	_room_join_cb_ref = JavaScriptBridge.create_callback(_on_js_room_join)
	win.__orbitGdRoomJoinCb = _room_join_cb_ref
	JavaScriptBridge.eval(
		"window.orbitSDK?.multiplayer?.onRoomJoin?.((p) => window.__orbitGdRoomJoinCb(JSON.stringify(p || null)))"
	)

	# 房主监听队友接受/婉拒邀请的实时回执
	_invite_resp_cb_ref = JavaScriptBridge.create_callback(_on_js_invite_responded)
	win.__orbitGdInviteRespCb = _invite_resp_cb_ref
	JavaScriptBridge.eval(
		"window.orbitSDK?.realtime?.onMessage?.((m) => { if (m && m.event === 'orbit.invite.responded') window.__orbitGdInviteRespCb(JSON.stringify(m.payload || {})); })"
	)

func is_in_orbit() -> bool:
	if not _is_web:
		return false
	return JavaScriptBridge.get_interface("orbitSDK") != null

func toast(message: String, tone: String = "info") -> void:
	if not is_in_orbit():
		print("[OrbitBridge.toast:%s] %s" % [tone, message])
		return
	JavaScriptBridge.get_interface("orbitSDK").ui.toast(message, tone)

func request_current_user() -> void:
	if not is_in_orbit():
		user_loaded.emit({"userId": "godot-local", "displayName": "Godot 本地调试"})
		return
	_user_cb_ref = JavaScriptBridge.create_callback(_on_js_user_resolved)
	JavaScriptBridge.get_interface("window").__orbitGdUserCb = _user_cb_ref
	JavaScriptBridge.eval(
		"window.orbitSDK.user.getCurrent().then((u) => window.__orbitGdUserCb(JSON.stringify(u || {}))).catch(() => window.__orbitGdUserCb('{}'))"
	)

func save_cloud_kv(key: String, value: Variant) -> void:
	if not is_in_orbit():
		return
	var json_str := JSON.stringify(value)
	JavaScriptBridge.eval("window.orbitSDK.storage.set(%s, JSON.parse(%s))" % [JSON.stringify(key), JSON.stringify(json_str)])

# ── 多人联机与工作室组队直达进房（SDK v1.3.0+）──

func request_nakama_session() -> void:
	if not is_in_orbit():
		nakama_session_loaded.emit({"ok": false, "error": "Godot 编辑器预览无法换取线上 Nakama 凭证"})
		return
	_nakama_cb_ref = JavaScriptBridge.create_callback(_on_js_nakama_session)
	JavaScriptBridge.get_interface("window").__orbitGdNakamaCb = _nakama_cb_ref
	JavaScriptBridge.eval(
		"window.orbitSDK.multiplayer.getNakamaSession().then((s) => window.__orbitGdNakamaCb(JSON.stringify(s))).catch((e) => window.__orbitGdNakamaCb(JSON.stringify({ok:false,error:e?.message||String(e)})))"
	)

func request_studio_members(include_self: bool = false) -> void:
	if not is_in_orbit():
		studio_members_loaded.emit([
			{"userId": "dev-teammate-1", "username": "teammate1", "displayName": "测试队友 A", "enrollYear": 2025, "isPlayingThisApp": true}
		])
		return
	_members_cb_ref = JavaScriptBridge.create_callback(_on_js_studio_members)
	JavaScriptBridge.get_interface("window").__orbitGdMembersCb = _members_cb_ref
	var flag := "true" if include_self else "false"
	JavaScriptBridge.eval(
		"window.orbitSDK.multiplayer.listStudioMembers({includeSelf:%s}).then((arr) => window.__orbitGdMembersCb(JSON.stringify(arr || []))).catch(() => window.__orbitGdMembersCb('[]'))" % flag
	)

func send_room_invite(
	to_user_ids: Array,
	room_id: String,
	room_name: String = "",
	message: String = "",
	mode: String = "",
	meta: Dictionary = {}
) -> void:
	var payload := {
		"toUserIds": to_user_ids,
		"roomId": room_id,
	}
	if room_name != "":
		payload["roomName"] = room_name
	if message != "":
		payload["message"] = message
	if mode != "":
		payload["mode"] = mode
	if not meta.is_empty():
		payload["meta"] = meta

	if not is_in_orbit():
		print("[OrbitBridge.send_room_invite] ", JSON.stringify(payload))
		room_invite_sent.emit({"ok": true, "roomId": room_id, "sent": []})
		return

	_invite_cb_ref = JavaScriptBridge.create_callback(_on_js_invite_sent)
	JavaScriptBridge.get_interface("window").__orbitGdInviteCb = _invite_cb_ref
	var payload_json := JSON.stringify(payload)
	JavaScriptBridge.eval(
		"window.orbitSDK.multiplayer.sendRoomInvite(JSON.parse(%s)).then((r) => window.__orbitGdInviteCb(JSON.stringify(r))).catch((e) => window.__orbitGdInviteCb(JSON.stringify({ok:false,error:e?.message||String(e)})))" % JSON.stringify(payload_json)
	)

func request_launch_room() -> void:
	if not is_in_orbit():
		return
	_launch_room_cb_ref = JavaScriptBridge.create_callback(_on_js_room_join)
	JavaScriptBridge.get_interface("window").__orbitGdLaunchRoomCb = _launch_room_cb_ref
	JavaScriptBridge.eval(
		"window.orbitSDK.multiplayer.getLaunchRoom().then((p) => { if (p) window.__orbitGdLaunchRoomCb(JSON.stringify(p)); })"
	)

func _on_js_user_resolved(args: Array) -> void:
	if args.size() == 0:
		user_loaded.emit({})
		return
	var parsed = JSON.parse_string(str(args[0]))
	user_loaded.emit(parsed if parsed is Dictionary else {})

func _on_js_theme_changed(args: Array) -> void:
	if args.size() > 0:
		theme_changed.emit(str(args[0]))

func _on_js_nakama_session(args: Array) -> void:
	if args.size() == 0:
		return
	var parsed = JSON.parse_string(str(args[0]))
	if parsed is Dictionary:
		nakama_session_loaded.emit(parsed)

func _on_js_studio_members(args: Array) -> void:
	if args.size() == 0:
		studio_members_loaded.emit([])
		return
	var parsed = JSON.parse_string(str(args[0]))
	studio_members_loaded.emit(parsed if parsed is Array else [])

func _on_js_invite_sent(args: Array) -> void:
	if args.size() == 0:
		return
	var parsed = JSON.parse_string(str(args[0]))
	if parsed is Dictionary:
		room_invite_sent.emit(parsed)

func _on_js_room_join(args: Array) -> void:
	if args.size() == 0:
		return
	var parsed = JSON.parse_string(str(args[0]))
	if parsed is Dictionary and not parsed.is_empty():
		room_join_received.emit(parsed)

func _on_js_invite_responded(args: Array) -> void:
	if args.size() == 0:
		return
	var parsed = JSON.parse_string(str(args[0]))
	if parsed is Dictionary:
		invite_responded.emit(parsed)
