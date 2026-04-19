//! Clipboard fallbacks for Mini-Term.
//! On Windows we read screenshot-style image formats directly from Win32 and
//! persist them into an app temp directory for terminal paste workflows.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const CLIPBOARD_TEMP_DIR: &str = "mini-term-clipboard";
const CLIPBOARD_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

fn clipboard_temp_dir() -> PathBuf {
    std::env::temp_dir().join(CLIPBOARD_TEMP_DIR)
}

fn unique_clipboard_path(prefix: &str, extension: &str) -> PathBuf {
    clipboard_temp_dir().join(format!("{prefix}-{}.{}", Uuid::now_v7(), extension))
}

fn ensure_clipboard_temp_dir() -> Result<PathBuf, String> {
    let dir = clipboard_temp_dir();
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create clipboard temp dir: {error}"))?;
    Ok(dir)
}

#[cfg(windows)]
mod win {
    use super::{ensure_clipboard_temp_dir, unique_clipboard_path};
    use image::{ImageBuffer, RgbaImage};
    use std::path::{Path, PathBuf};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::Graphics::Gdi::{
        BITMAP, BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC,
        GetDIBits, GetObjectW, HBITMAP, SelectObject,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;

    pub fn read_clipboard_to_png() -> Result<PathBuf, String> {
        unsafe {
            OpenClipboard(None).map_err(|_| "failed to open clipboard".to_string())?;
            let result = read_inner();
            let _ = CloseClipboard();
            result
        }
    }

    unsafe fn read_inner() -> Result<PathBuf, String> {
        if IsClipboardFormatAvailable(CF_DIB).is_ok() {
            if let Ok(image) = read_dib() {
                return save_png(&image);
            }
        }
        if IsClipboardFormatAvailable(CF_BITMAP).is_ok() {
            if let Ok(image) = read_bitmap() {
                return save_png(&image);
            }
        }
        Err("clipboard does not contain a supported image format".to_string())
    }

    unsafe fn read_dib() -> Result<RgbaImage, String> {
        let handle = GetClipboardData(CF_DIB)
            .map_err(|error| format!("GetClipboardData(CF_DIB) failed: {error}"))?;
        let hglobal = HGLOBAL(handle.0);
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return Err("GlobalLock failed".to_string());
        }
        let size = GlobalSize(hglobal);
        let result = parse_dib(ptr, size);
        let _ = GlobalUnlock(hglobal);
        result
    }

    unsafe fn parse_dib(ptr: *const u8, size: usize) -> Result<RgbaImage, String> {
        if size < std::mem::size_of::<BITMAPINFOHEADER>() {
            return Err("DIB payload is too short".to_string());
        }

        let header = &*(ptr as *const BITMAPINFOHEADER);
        let width = header.biWidth as u32;
        let height = header.biHeight.unsigned_abs();
        let bit_count = header.biBitCount;

        if header.biCompression != BI_RGB.0 {
            return Err(format!(
                "unsupported DIB compression mode: {}",
                header.biCompression
            ));
        }

        let header_size = header.biSize as usize;
        let pixel_offset = if bit_count <= 8 {
            let palette_entries = if header.biClrUsed > 0 {
                header.biClrUsed as usize
            } else {
                1usize << bit_count
            };
            header_size + palette_entries * 4
        } else {
            header_size
        };

        if pixel_offset >= size {
            return Err("pixel data offset is out of range".to_string());
        }

        let pixels = ptr.add(pixel_offset);
        let stride = ((width * bit_count as u32).div_ceil(32) * 4) as usize;
        let bottom_up = header.biHeight > 0;
        let mut image = RgbaImage::new(width, height);

        for y in 0..height {
            let src_y = if bottom_up { height - 1 - y } else { y };
            let row = pixels.add(src_y as usize * stride);
            for x in 0..width {
                let (r, g, b, a) = match bit_count {
                    32 => {
                        let offset = (x * 4) as usize;
                        (
                            *row.add(offset + 2),
                            *row.add(offset + 1),
                            *row.add(offset),
                            *row.add(offset + 3),
                        )
                    }
                    24 => {
                        let offset = (x * 3) as usize;
                        (
                            *row.add(offset + 2),
                            *row.add(offset + 1),
                            *row.add(offset),
                            255,
                        )
                    }
                    _ => return Err(format!("unsupported bitmap depth: {bit_count}")),
                };
                image.put_pixel(x, y, image::Rgba([r, g, b, a]));
            }
        }

        Ok(image)
    }

    unsafe fn read_bitmap() -> Result<RgbaImage, String> {
        let handle = GetClipboardData(CF_BITMAP)
            .map_err(|error| format!("GetClipboardData(CF_BITMAP) failed: {error}"))?;
        let hbitmap = HBITMAP(handle.0);

        let mut bitmap = BITMAP::default();
        let read = GetObjectW(
            hbitmap,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bitmap as *mut _ as *mut _),
        );
        if read == 0 {
            return Err("GetObjectW failed".to_string());
        }

        let width = bitmap.bmWidth as u32;
        let height = bitmap.bmHeight as u32;
        let hdc = CreateCompatibleDC(None);
        let old = SelectObject(hdc, hbitmap);

        let mut info = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..std::mem::zeroed()
        };

        let mut buffer = vec![0u8; (width * height * 4) as usize];
        let read = GetDIBits(
            hdc,
            hbitmap,
            0,
            height,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut info as *mut _ as *mut _,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc, old);
        let _ = DeleteDC(hdc);

        if read == 0 {
            return Err("GetDIBits failed".to_string());
        }

        for chunk in buffer.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        ImageBuffer::from_raw(width, height, buffer)
            .ok_or_else(|| "failed to build image buffer".to_string())
    }

    fn save_png(image: &RgbaImage) -> Result<PathBuf, String> {
        ensure_clipboard_temp_dir()?;
        let path = unique_clipboard_path("clip", "png");
        image
            .save(&path)
            .map_err(|error| format!("failed to save PNG: {error}"))?;
        Ok(path)
    }

    #[allow(dead_code)]
    pub fn debug_save_path(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
}

pub fn cleanup_old_clipboard_images() {
    let dir = clipboard_temp_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(CLIPBOARD_RETENTION)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in entries.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub fn read_clipboard_image() -> Result<String, String> {
    #[cfg(windows)]
    {
        let path = win::read_clipboard_to_png()?;
        Ok(path.to_string_lossy().into_owned())
    }

    #[cfg(not(windows))]
    {
        Err("clipboard image fallback is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn save_clipboard_text(text: String) -> Result<String, String> {
    ensure_clipboard_temp_dir()?;
    let path = unique_clipboard_path("paste", "txt");
    std::fs::write(&path, text.as_bytes())
        .map_err(|error| format!("failed to write clipboard temp file: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn save_clipboard_text_uses_unique_unpredictable_paths() {
        let first = save_clipboard_text("one".to_string()).unwrap();
        let second = save_clipboard_text("two".to_string()).unwrap();

        assert_ne!(first, second);
        assert!(Path::new(&first).file_name().unwrap().to_string_lossy().starts_with("paste-"));
        assert!(Path::new(&second).file_name().unwrap().to_string_lossy().starts_with("paste-"));

        let _ = std::fs::remove_file(first);
        let _ = std::fs::remove_file(second);
    }

    #[test]
    fn save_clipboard_text_persists_contents() {
        let path = save_clipboard_text("clipboard payload".to_string()).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert_eq!(saved, "clipboard payload");
        let _ = std::fs::remove_file(path);
    }
}
