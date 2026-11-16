// Test-only foreign executable. Never accepts or prints plaintext key material.
#include <Security/Security.h>
#include <stdint.h>
#include <string.h>
extern int32_t cw_key_load(SecKeychainRef, const uint8_t[16], uint8_t[32]);
static int nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}
int main(int argc, char **argv) {
    if (argc != 3 || strlen(argv[2]) != 32) return 90;
    uint8_t id[16], key[32];
    for (int i = 0; i < 16; ++i) {
        int a = nibble(argv[2][i * 2]), b = nibble(argv[2][i * 2 + 1]);
        if (a < 0 || b < 0) return 90;
        id[i] = (uint8_t)((a << 4) | b);
    }
    SecKeychainRef keychain = NULL;
    if (SecKeychainSetUserInteractionAllowed(false) || SecKeychainOpen(argv[1], &keychain)) return 91;
    int32_t status = cw_key_load(keychain, id, key);
    CFRelease(keychain);
    // Distinguish the expected authorization failure from missing/corrupt data.
    if (status == errSecAuthFailed || status == errSecInteractionNotAllowed) return 2;
    return status == 0 ? 0 : 92;
}
