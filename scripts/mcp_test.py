#!/usr/bin/env python3
import subprocess, json, sys
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MCP_BIN = "D:/code/JavaScript/mini-term/src-tauri/target/debug/mini-term-mcp.exe"
proc = subprocess.Popen([MCP_BIN], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

_id = 0
def send(method, params=None):
    global _id; _id += 1
    msg = {"jsonrpc": "2.0", "id": _id, "method": method}
    if params: msg["params"] = params
    body = json.dumps(msg).encode("utf-8")
    proc.stdin.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
    proc.stdin.flush()

def read_one():
    headers = {}
    while True:
        line = proc.stdout.readline().rstrip(b"\r\n")
        if line == b"": break
        k, _, v = line.partition(b":")
        headers[k.strip().lower()] = v.strip()
    n = int(headers[b"content-length"])
    body = b""
    while len(body) < n:
        body += proc.stdout.read(n - len(body))
    return json.loads(body.decode("utf-8"))

def tool_call(name, args=None):
    send("tools/call", {"name": name, "arguments": args or {}})
    resp = read_one()
    sc = resp.get("result", {}).get("structuredContent")
    if sc is None:
        return None, f"RPC error: {resp.get('error')}"
    if sc.get("requiresConfirmation"):
        return sc, None
    if not sc.get("ok"):
        return None, sc.get("error", "unknown error")
    return sc.get("data"), None

send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
read_one()
send("notifications/initialized")
proc.stdin.flush()

print("=== MCP Comprehensive Test ===\n")

# 1. Standard tools/list
print("[1] tools/list (standard MCP)")
send("tools/list", {})
r = read_one()
tools = r.get("result", {}).get("tools", [])
print(f"    -> {len(tools)} tools registered")

# 2. ping tool
print("[2] ping")
data, err = tool_call("ping")
if err: print(f"    -> ERROR: {err}")
else: print(f"    -> {data}")

# 3. server_info
print("[3] server_info")
data, err = tool_call("server_info")
if err: print(f"    -> ERROR: {err}")
else:
    print(f"    -> serverVersion={data.get('serverVersion')}, appVersion={data.get('appVersion')}")
    conn = data.get("hostConnection", {})
    print(f"       host: status={conn.get('status')}, mode={conn.get('mode')}, pid={conn.get('desktopPid')}")
    for d in data.get("diagnostics", []):
        print(f"       [{d.get('level')}] {d.get('message')}")

# 4. list_tools with group filter
print("[4] list_tools (all)")
data, err = tool_call("list_tools")
if err: print(f"    -> ERROR: {err}")
else:
    items = data.get("items", [])
    by_group = {}
    for t in items:
        g = t.get("group", "?")
        by_group.setdefault(g, []).append(t["name"])
    for g, names in sorted(by_group.items()):
        print(f"    [{g}] {', '.join(names)}")

print("[4b] list_tools (group=core-runtime)")
data, err = tool_call("list_tools", {"group": "core-runtime"})
if err: print(f"    -> ERROR: {err}")
else:
    items = data.get("items", [])
    print(f"    -> {len(items)} tools: {[t['name'] for t in items]}")

# 5. list_workspaces
print("[5] list_workspaces")
data, err = tool_call("list_workspaces")
workspace_id = None
if err: print(f"    -> ERROR: {err}")
else:
    workspaces = data if isinstance(data, list) else data.get("workspaces", [])
    print(f"    -> {len(workspaces)} workspaces")
    for w in workspaces:
        print(f"      id={w.get('workspaceId')}, name={w.get('name')}")
    if workspaces:
        workspace_id = workspaces[0].get("workspaceId")

# 6. get_config
print("[6] get_config")
data, err = tool_call("get_config")
if err: print(f"    -> ERROR: {err}")
else:
    cfg = data.get("config", data)  # data wraps under "config" key
    print(f"    -> defaultShell={cfg.get('defaultShell')}, fontSize={cfg.get('fontSize')}")

# 7. list_ptys with pagination (param is "limit", not "pageSize")
print("[7] list_ptys (limit=3)")
data, err = tool_call("list_ptys", {"limit": 3})
if err: print(f"    -> ERROR: {err}")
else:
    ptys = data.get("items", [])
    cursor = data.get("nextCursor")
    print(f"    -> {len(ptys)} ptys, nextCursor={'yes' if cursor else 'none'}")
    for p in ptys[:2]:
        preview = p.get("outputPreview", "")[:60].replace("\n", "\\n")
        print(f"      pty={p.get('ptyId')}, phase={p.get('phase')}, preview='{preview}'")
    if cursor:
        print("[7b] list_ptys page 2")
        data2, err2 = tool_call("list_ptys", {"limit": 3, "cursor": cursor})
        if err2: print(f"    -> ERROR: {err2}")
        else:
            ptys2 = data2.get("items", [])
            print(f"    -> {len(ptys2)} ptys on page 2")

# 8. list_fs_watches
print("[8] list_fs_watches")
data, err = tool_call("list_fs_watches")
if err: print(f"    -> ERROR: {err}")
else:
    watches = data.get("items", data.get("watches", []))
    print(f"    -> {len(watches)} active watches")

# 9. get_recent_events
print("[9] get_recent_events (limit=5)")
data, err = tool_call("get_recent_events", {"limit": 5})
if err: print(f"    -> ERROR: {err}")
else:
    events = data.get("items", data.get("events", []))
    print(f"    -> {len(events)} events")
    for e in events[:3]:
        etype = e.get("kind", e.get("type", e.get("eventType", "?")))
        payload = str(e.get("payloadPreview", e.get("summary", e.get("payload", ""))))[:60]
        print(f"      [{etype}] {payload}")

# 10. get_workspace_context
print("[10] get_workspace_context")
if workspace_id:
    data, err = tool_call("get_workspace_context", {"workspaceId": workspace_id})
    if err: print(f"    -> ERROR: {err}")
    else:
        tabs = data.get("tabs", [])
        print(f"    -> tabs={len(tabs)}, activeTabId={data.get('activeTabId')}")
        for t in tabs[:2]:
            print(f"      tab={t.get('tabId')}, title={t.get('title')}")
else:
    print("    (no workspace id)")

# 11. get_ai_sessions
print("[11] get_ai_sessions")
data, err = tool_call("get_ai_sessions")
if err: print(f"    -> ERROR: {err}")
else:
    sessions = data.get("sessions", data if isinstance(data, list) else [])
    print(f"    -> {len(sessions)} AI sessions")
    for s in sessions[:3]:
        print(f"      tool={s.get('tool')}, id={str(s.get('sessionId', s.get('id', '?')))[:20]}")

# 12. read_file
print("[12] read_file")
data, err = tool_call("read_file", {"path": "D:/code/JavaScript/mini-term/CLAUDE.md"})
if err: print(f"    -> ERROR: {err}")
else:
    content = data.get("content", str(data))
    lines = content.splitlines()
    print(f"    -> {len(content)} chars, {len(lines)} lines")
    print(f"       first: '{lines[0] if lines else ''}'")

# 13. search_files
print("[13] search_files")
data, err = tool_call("search_files", {"rootPath": "D:/code/JavaScript/mini-term", "query": "fn list_ptys", "maxResults": 5})
if err: print(f"    -> ERROR: {err}")
else:
    matches = data.get("matches", data.get("items", data.get("results", [])) if isinstance(data, dict) else [])
    print(f"    -> {len(matches)} matches")
    for m in matches[:3]:
        fpath = m.get("file", m.get("path", m.get("filePath", "?")))
        line = m.get("line", m.get("lineNumber", "?"))
        snippet = str(m.get("snippet", m.get("text", m.get("content", ""))))[:50]
        print(f"      {fpath}:{line} - {snippet}")

# 14. get_git_summary
print("[14] get_git_summary")
data, err = tool_call("get_git_summary", {"projectPath": "D:/code/JavaScript/mini-term"})
if err: print(f"    -> ERROR: {err}")
else:
    branch = data.get("branch", data.get("currentBranch", "?"))
    modified = data.get("modifiedFiles", data.get("modified", []))
    untracked = data.get("untrackedFiles", data.get("untracked", []))
    print(f"    -> branch={branch}, modified={len(modified)}, untracked={len(untracked)}")

# 15. list_approval_requests
print("[15] list_approval_requests")
data, err = tool_call("list_approval_requests")
if err: print(f"    -> ERROR: {err}")
else:
    reqs = data if isinstance(data, list) else data.get("items", data.get("requests", []))
    print(f"    -> {len(reqs)} approval requests")

# 16. set_config_fields - write tool requiresConfirmation
print("[16] set_config_fields (write tool - expect requiresConfirmation)")
data, err = tool_call("set_config_fields", {"fontSize": 16})
if err: print(f"    -> ERROR: {err}")
elif data and data.get("requiresConfirmation"):
    key = data.get("approvalKey", "")[:32]
    prompt = data.get("confirmationPrompt", data.get("prompt", ""))[:80]
    print(f"    -> requiresConfirmation=True (correct)")
    print(f"       approvalKey={key}...")
    print(f"       prompt: {prompt}")
elif data and data.get("ok"):
    print(f"    -> ok (written without confirmation)")
else:
    print(f"    -> {data}")

print("\n=== Test Complete ===")
proc.terminate()
