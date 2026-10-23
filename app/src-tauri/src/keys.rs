// What keys type on the keyboard layout in use, for the shortcuts the
// webview matches by the key's place rather than its character (Back is ⌘
// and the key right of P: [ on a US layout, Å on a Norwegian one). WKWebView
// has no navigator.keyboard.getLayoutMap(), so the Mac app asks macOS: the
// input source's keyboard layout (Text Input Sources), and UCKeyTranslate
// for what each key types there with no modifier. A dead key (Norwegian ¨)
// gives its mark on its own. The webview shows these in place of a US
// keyboard's keys (app/src/lib/keyboard-layout.ts).

use std::collections::HashMap;

// labels is what each of codes (KeyboardEvent.code, "BracketLeft") types on
// the layout in use. A code it doesn't know, or that types nothing it can
// show, is left out; off a Mac, all of them are, and the webview learns the
// layout as keys are pressed instead.
pub fn labels(codes: &[String]) -> HashMap<String, String> {
    #[cfg(target_os = "macos")]
    {
        mac::current(codes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = codes;
        HashMap::new()
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::collections::HashMap;
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;
    type UniCharCount = std::os::raw::c_ulong;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        pub(super) static kTISPropertyUnicodeKeyLayoutData: CFTypeRef;
        fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
        pub(super) fn TISGetInputSourceProperty(source: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn LMGetKbdType() -> u8;
        fn UCKeyTranslate(
            layout: *const u8,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: UniCharCount,
            actual_string_length: *mut UniCharCount,
            unicode_string: *mut u16,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub(super) fn CFDataGetBytePtr(data: CFTypeRef) -> *const u8;
        pub(super) fn CFRelease(cf: CFTypeRef);
    }

    // mac_key is the macOS virtual key code (Events.h, kVK_ANSI_*) of a
    // KeyboardEvent.code: the same physical key.
    fn mac_key(code: &str) -> Option<u16> {
        Some(match code {
            "BracketLeft" => 0x21,
            "BracketRight" => 0x1E,
            "KeyC" => 0x08,
            "KeyD" => 0x02,
            "KeyI" => 0x22,
            "KeyS" => 0x01,
            _ => return None,
        })
    }

    const KEY_ACTION_DISPLAY: u16 = 3;
    const NO_DEAD_KEYS: u32 = 1;

    // current reads the keyboard layout of the input source in use: an
    // input method's (Japanese, Pinyin) too, as it types letters with ⌘.
    // Text Input Sources wants the main thread, where Tauri runs a command
    // that isn't async.
    pub fn current(codes: &[String]) -> HashMap<String, String> {
        unsafe {
            let source = TISCopyCurrentKeyboardLayoutInputSource();
            if source.is_null() {
                return HashMap::new();
            }
            let out = from_source(source, codes);
            CFRelease(source);
            out
        }
    }

    // from_source is labels for an input source.
    pub(super) unsafe fn from_source(source: CFTypeRef, codes: &[String]) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        if data.is_null() {
            return out;
        }
        let layout = CFDataGetBytePtr(data);
        let kbd = LMGetKbdType() as u32;
        for code in codes {
            let Some(key) = mac_key(code) else {
                continue;
            };
            let mut dead = 0u32;
            let mut len: UniCharCount = 0;
            let mut buf = [0u16; 4];
            let status = UCKeyTranslate(
                layout,
                key,
                KEY_ACTION_DISPLAY,
                0,
                kbd,
                NO_DEAD_KEYS,
                &mut dead,
                buf.len() as UniCharCount,
                &mut len,
                buf.as_mut_ptr(),
            );
            if status != 0 || len == 0 {
                continue;
            }
            if let Ok(s) = String::from_utf16(&buf[..len as usize]) {
                if !s.trim().is_empty() {
                    out.insert(code.clone(), s);
                }
            }
        }
        out
    }
}

// A layout by its input source id, installed on every Mac whether it is in
// use or not: what the keys type there, without switching to it.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::mac::{CFRelease, TISGetInputSourceProperty};
    use std::collections::HashMap;
    use std::ffi::c_void;

    type CFTypeRef = *const c_void;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        static kTISPropertyInputSourceID: CFTypeRef;
        fn TISCreateInputSourceList(properties: CFTypeRef, include_all_installed: bool) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: isize, encoding: u32, external: bool) -> CFTypeRef;
        fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: isize, kcb: *const c_void, vcb: *const c_void) -> CFTypeRef;
        fn CFArrayGetCount(a: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
    }

    fn on(id: &str) -> HashMap<String, String> {
        let codes: Vec<String> = ["BracketLeft", "BracketRight", "KeyD", "Escape"].map(String::from).to_vec();
        unsafe {
            let id = CFStringCreateWithBytes(std::ptr::null(), id.as_ptr(), id.len() as isize, 0x0800_0100, false);
            let key = kTISPropertyInputSourceID;
            let filter = CFDictionaryCreate(std::ptr::null(), &key, &id, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            let list = TISCreateInputSourceList(filter, true);
            assert!(!list.is_null() && CFArrayGetCount(list) > 0, "no input source {id:?}");
            let source = CFArrayGetValueAtIndex(list, 0);
            assert!(!TISGetInputSourceProperty(source, super::mac::kTISPropertyUnicodeKeyLayoutData).is_null());
            let out = super::mac::from_source(source, &codes);
            CFRelease(list);
            CFRelease(filter);
            CFRelease(id);
            out
        }
    }

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn keys_in_their_place_on_each_layout() {
        assert_eq!(on("com.apple.keylayout.US"), labels(&[("BracketLeft", "["), ("BracketRight", "]"), ("KeyD", "d")]));
        assert_eq!(on("com.apple.keylayout.Norwegian"), labels(&[("BracketLeft", "å"), ("BracketRight", "¨"), ("KeyD", "d")]));
        assert_eq!(on("com.apple.keylayout.German"), labels(&[("BracketLeft", "ü"), ("BracketRight", "+"), ("KeyD", "d")]));
        assert_eq!(on("com.apple.keylayout.Dvorak"), labels(&[("BracketLeft", "/"), ("BracketRight", "="), ("KeyD", "e")]));
    }

    #[test]
    fn the_layout_in_use_says_something() {
        assert!(super::mac::current(&["KeyD".to_string()]).contains_key("KeyD"));
    }
}
