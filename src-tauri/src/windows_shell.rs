#[cfg(target_os = "windows")]
pub fn powershell_utf8_bootstrap_script() -> String {
    [
        "$miniTermUtf8 = New-Object System.Text.UTF8Encoding $false",
        "try { [Console]::InputEncoding = $miniTermUtf8 } catch {}",
        "try { [Console]::OutputEncoding = $miniTermUtf8 } catch {}",
        "try { $OutputEncoding = $miniTermUtf8 } catch {}",
    ]
    .join("; ")
}

#[cfg(target_os = "windows")]
pub fn cmd_utf8_bootstrap_command() -> String {
    "chcp 65001 > nul".to_string()
}
