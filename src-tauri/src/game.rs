//! Tells whether Destiny 2 is running, so auto sync can sync more often while the player plays.

/// The Destiny 2 game process on PC (Steam and Epic both run this executable).
#[cfg(windows)]
const GAME_EXE: &str = "destiny2.exe";

#[cfg(windows)]
fn destiny_running() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };

    // SAFETY: the snapshot handle is checked before use and closed exactly once; `entry` is a
    // properly sized PROCESSENTRY32W that the API fills in.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
            return false;
        }
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case(GAME_EXE) {
                found = true;
                break;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(not(windows))]
fn destiny_running() -> bool {
    false
}

/// True while Destiny 2 is running on this PC.
#[tauri::command]
pub fn game_running() -> bool {
    destiny_running()
}
