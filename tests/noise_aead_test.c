#include "chacha20poly1305.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

static const uint8_t expected[] = {
	0xa1, 0x89, 0xcc, 0x8b, 0xc0, 0xac, 0xce, 0xf5,
	0x68, 0xda, 0x8c, 0xf6, 0xfc, 0x89, 0x44, 0x2a,
	0xfa, 0xfe, 0x23, 0xe8, 0x2b, 0x08, 0x33, 0xe9,
	0x69, 0x86, 0x98, 0xf7, 0x38, 0xe2, 0x4c, 0x2c,
	0xde, 0x92,
};

int main(void) {
	uint8_t key[32];
	for (size_t index = 0; index < sizeof(key); index++)
		key[index] = (uint8_t)index;

	static const uint8_t ad[] = "tailscale-control";
	static const uint8_t plaintext[] = "Noise fixed vector";
	uint8_t ciphertext[sizeof(plaintext) - 1 + 16];
	uint8_t decrypted[sizeof(plaintext) - 1];
	const uint64_t counter = UINT64_C(0x0102030405060708);

	/* Tailscale stores the counter big-endian in nonce[4:12].
	 * The bundled WireGuard primitive serializes its integer little-endian. */
	chacha20poly1305_encrypt(ciphertext, plaintext, sizeof(plaintext) - 1,
		ad, sizeof(ad) - 1, __builtin_bswap64(counter), key);
	if (memcmp(ciphertext, expected, sizeof(expected))) {
		fprintf(stderr, "Noise AEAD encryption vector mismatch\n");
		return 1;
	}

	if (!chacha20poly1305_decrypt(decrypted, ciphertext, sizeof(ciphertext),
			ad, sizeof(ad) - 1, __builtin_bswap64(counter), key)) {
		fprintf(stderr, "Noise AEAD decryption failed\n");
		return 1;
	}
	if (memcmp(decrypted, plaintext, sizeof(decrypted))) {
		fprintf(stderr, "Noise AEAD plaintext mismatch\n");
		return 1;
	}

	ciphertext[sizeof(ciphertext) - 1] ^= 1;
	if (chacha20poly1305_decrypt(decrypted, ciphertext, sizeof(ciphertext),
			ad, sizeof(ad) - 1, __builtin_bswap64(counter), key)) {
		fprintf(stderr, "Noise AEAD accepted a modified tag\n");
		return 1;
	}

	puts("Noise AEAD fixed vector: OK");
	return 0;
}
