use std::path::Path;
use std::process::Command;

/// 使用用户在设置中配置的 VS Code 可执行文件打开指定路径。
///
/// `executable` 由前端从 `AppConfig.vscode_path` 取出后传入。
/// 未配置或配置无效时返回错误字符串，由前端提示用户。
#[tauri::command]
pub fn open_in_vscode(path: String, executable: String) -> Result<(), String> {
    let exe = executable.trim();
    if exe.is_empty() {
        return Err(
            "尚未配置 VS Code 可执行文件路径，请在『设置 → 系统设置 → 外部编辑器』中指定。"
                .to_string(),
        );
    }

    let exe_path = Path::new(exe);
    if !exe_path.exists() {
        return Err(format!("配置的 VS Code 路径不存在：{}", exe));
    }

    let mut cmd = Command::new(exe_path);
    cmd.arg(&path);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("启动 VS Code 失败：{}", e))
}
