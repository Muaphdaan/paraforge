//! Paints the native Windows title bar in ParaForge's night colours.
//!
//! ParaForge keeps the real Windows title bar, so snap layouts, Aero Snap, the window menu
//! and screen readers keep working, and only recolours it. Windows 10 ignores the colours
//! and shows its dark title bar instead (the window's theme is set to dark).

use tauri::WebviewWindow;
use windows_sys::Win32::Graphics::Dwm::{
    DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DwmSetWindowAttribute,
};

/// A Windows COLORREF (0x00BBGGRR) from a 0xRRGGBB colour.
const fn colorref(rgb: u32) -> u32 {
    ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF)
}

const CAPTION: u32 = colorref(0x0B0D1F); // bg-top
const TEXT: u32 = colorref(0xEEF1FF); // text
const BORDER: u32 = colorref(0x2E3566); // border

pub fn paint_title_bar(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    for (attribute, value) in [(DWMWA_CAPTION_COLOR, CAPTION), (DWMWA_TEXT_COLOR, TEXT), (DWMWA_BORDER_COLOR, BORDER)] {
        // SAFETY: `hwnd` is this app's live main window and `value` outlives the call.
        // Errors (for example on Windows 10, which lacks these attributes) are ignored.
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute as u32,
                (&value as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}
