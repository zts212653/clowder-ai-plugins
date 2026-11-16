#define __STDC_WANT_LIB_EXT1__ 1
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdint.h>
#include <string.h>

static const char service[] = "ai.clowder.wechat-delegation.vault.v1";
static void account_name(const uint8_t id[16], char account[32]) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < 16; ++i) {
        account[i * 2] = hex[id[i] >> 4];
        account[i * 2 + 1] = hex[id[i] & 15];
    }
}

int32_t cw_key_create(SecKeychainRef keychain, const uint8_t id[16], const uint8_t key[32]) {
    if (!keychain || !id || !key) return errSecParam;
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status) return status;
    char account[32]; account_name(id, account);
    SecTrustedApplicationRef self = NULL;
    CFArrayRef applications = NULL;
    SecAccessRef access = NULL;
    SecKeychainItemRef item = NULL;
    // NULL refers to the calling executable, not a caller-supplied path or id.
    status = SecTrustedApplicationCreateFromPath(NULL, &self);
    if (status) goto cleanup;
    applications = CFArrayCreate(NULL, (const void **)&self, 1, &kCFTypeArrayCallBacks);
    if (!applications) { status = errSecAllocate; goto cleanup; }
    status = SecAccessCreate(CFSTR("Clowder WeChat private state"), applications, &access);
    if (status) goto cleanup;
    SecKeychainAttribute attributes[2] = {
        {kSecServiceItemAttr, sizeof(service) - 1, (void *)service},
        {kSecAccountItemAttr, sizeof(account), account}
    };
    SecKeychainAttributeList list = {2, attributes};
    // Explicit single-app ACL. Duplicate items fail; never modify their key/ACL.
    status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, 32, key, keychain, access, &item);
cleanup:
    if (item) CFRelease(item);
    if (access) CFRelease(access);
    if (applications) CFRelease(applications);
    if (self) CFRelease(self);
    return status;
}
static int32_t load_key(SecKeychainRef keychain, const uint8_t id[16], uint8_t key[32], Boolean interactive) {
    if (!keychain || !id || !key) return errSecParam;
    memset_s(key, 32, 0, 32);
    OSStatus status = SecKeychainSetUserInteractionAllowed(interactive);
    if (status) return status;
    if (interactive) {
        // Password is handled exclusively by the system's own dialog. This
        // entrypoint is used only by the one-shot owner-authorized process.
        status = SecKeychainUnlock(keychain, 0, NULL, false);
        if (status) goto restore;
    }
    char account[32]; account_name(id, account);
    UInt32 length = 0; void *bytes = NULL;
    // A concrete keychain handle prevents search-list fallback to another store.
    status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
        sizeof(account), account, &length, &bytes, NULL);
    if (!status) {
        if (length != 32 || !bytes) status = errSecDecode;
        else memcpy(key, bytes, 32);
    }
    if (bytes) {
        memset_s(bytes, length, 0, length);
        SecKeychainItemFreeContent(NULL, bytes);
    }
restore:
    {
        OSStatus restored = SecKeychainSetUserInteractionAllowed(false);
        if (restored) { memset_s(key, 32, 0, 32); return restored; }
    }
    return status;
}
int32_t cw_key_load(SecKeychainRef keychain, const uint8_t id[16], uint8_t key[32]) {
    return load_key(keychain, id, key, false);
}
int32_t cw_key_reauthorize(SecKeychainRef keychain, const uint8_t id[16], uint8_t key[32]) {
    return load_key(keychain, id, key, true);
}
