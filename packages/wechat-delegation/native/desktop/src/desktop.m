// Fixed read-only desktop evidence. No profile, memory, screenshot, chat text,
// key export, window activation or UI action is used by this probe.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Security/Security.h>
#include <stdbool.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>

static bool official(NSURL *url) {
    if (!url) return false;
    SecStaticCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
    if (status == errSecSuccess) {
        status = SecRequirementCreateWithString(CFSTR("anchor apple generic and identifier \"com.tencent.xinWeChat\" and certificate leaf[subject.OU] = \"5A4RE8SF68\""), kSecCSDefaultFlags, &requirement);
    }
    if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSDefaultFlags, requirement);
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return status == errSecSuccess;
}
static CFTypeRef attribute(AXUIElementRef element, CFStringRef key) {
    AXUIElementSetMessagingTimeout(element, 0.15f);
    CFTypeRef result = NULL;
    if (AXUIElementCopyAttributeValue(element, key, &result) != kAXErrorSuccess) {
        if (result) CFRelease(result);
        return NULL;
    }
    return result;
}
static bool logout_enabled(AXUIElementRef app) {
    bool found = false;
    CFTypeRef bar = attribute(app, kAXMenuBarAttribute);
    if (!bar || CFGetTypeID(bar) != AXUIElementGetTypeID()) goto done;
    CFTypeRef items = attribute((AXUIElementRef)bar, kAXChildrenAttribute);
    if (!items || CFGetTypeID(items) != CFArrayGetTypeID() || CFArrayGetCount(items) < 1) {
        if (items) CFRelease(items);
        goto done;
    }
    AXUIElementRef first = (AXUIElementRef)CFArrayGetValueAtIndex(items, 0);
    CFTypeRef menus = CFGetTypeID(first) == AXUIElementGetTypeID() ? attribute(first, kAXChildrenAttribute) : NULL;
    if (menus && CFGetTypeID(menus) == CFArrayGetTypeID()) {
        // Only the app menu, never the Window menu or conversation controls.
        CFIndex count = CFArrayGetCount(menus);
        for (CFIndex i = 0; i < count && i < 2 && !found; i++) {
            AXUIElementRef menu = (AXUIElementRef)CFArrayGetValueAtIndex(menus, i);
            if (CFGetTypeID(menu) != AXUIElementGetTypeID()) continue;
            CFTypeRef commands = attribute(menu, kAXChildrenAttribute);
            if (commands && CFGetTypeID(commands) == CFArrayGetTypeID()) {
                CFIndex n = CFArrayGetCount(commands);
                for (CFIndex j = 0; j < n && j < 24 && !found; j++) {
                    AXUIElementRef command = (AXUIElementRef)CFArrayGetValueAtIndex(commands, j);
                    if (CFGetTypeID(command) != AXUIElementGetTypeID()) continue;
                    CFTypeRef title = attribute(command, kAXTitleAttribute);
                    if (title && CFGetTypeID(title) == CFStringGetTypeID() &&
                        (CFEqual(title, CFSTR("退出登录")) || CFEqual(title, CFSTR("退出登入")) ||
                         CFEqual(title, CFSTR("Log Out")) || CFEqual(title, CFSTR("Logout")) ||
                         CFEqual(title, CFSTR("Sign Out")) || CFEqual(title, CFSTR("登出")))) {
                        CFTypeRef enabled = attribute(command, kAXEnabledAttribute);
                        found = enabled && CFGetTypeID(enabled) == CFBooleanGetTypeID() && CFBooleanGetValue(enabled);
                        if (enabled) CFRelease(enabled);
                    }
                    if (title) CFRelease(title);
                }
            }
            if (commands) CFRelease(commands);
        }
    }
    if (menus) CFRelease(menus);
    CFRelease(items);
done:
    if (bar) CFRelease(bar);
    return found;
}

int cw_desktop_probe(bool prompt, char *version, size_t capacity) {
    if (capacity) version[0] = 0;
    if (geteuid() == 0 || geteuid() != getuid()) return 0;
    struct rlimit limit = {0, 0};
    if (setrlimit(RLIMIT_CORE, &limit) != 0) return 0;
    @autoreleasepool {
        NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.tencent.xinWeChat"];
        if (apps.count > 1) return 3;
        NSURL *url = apps.count ? apps.firstObject.bundleURL : [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:@"com.tencent.xinWeChat"];
        if (!url) return 1;
        if (!official(url)) return 4;
        NSString *v = [[NSBundle bundleWithURL:url] objectForInfoDictionaryKey:@"CFBundleShortVersionString"];
        if ([v isKindOfClass:[NSString class]] && v.length > 0 && v.length < capacity &&
            [v rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789."] invertedSet]].location == NSNotFound) {
            const char *bytes = v.UTF8String;
            if (bytes && strlen(bytes) < capacity) memcpy(version, bytes, strlen(bytes) + 1);
        }
        if (apps.count == 0) return 2;
        // Only the inspected version may produce positive UI evidence.
        if (strcmp(version, "4.2.0") != 0) return 8;
        // Prompting is permitted only by a separate explicit owner action.
        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)};
        if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options)) return 5;
        AXUIElementRef app = AXUIElementCreateApplication(apps.firstObject.processIdentifier);
        bool logged_in_ui = logout_enabled(app);
        CFRelease(app);
        return logged_in_ui ? 6 : 8;
    }
}
