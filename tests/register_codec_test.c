#include "ml_register_codec.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static void test_request_fixtures(void) {
    const uint8_t node_key[32] = {1, 2, 3};
    const uint8_t old_node_key[32] = {4, 5, 6};
    ml_register_request_fields_t initial;
    ml_register_request_fields_init(&initial, node_key, old_node_key, false, NULL, NULL);
    assert(initial.node_key == node_key);
    assert(initial.old_node_key == NULL);
    assert(initial.auth_key == NULL);
    assert(initial.followup == NULL);

    ml_register_request_fields_t keyed;
    ml_register_request_fields_init(&keyed, node_key, old_node_key, false,
                                    "tskey-auth-fixture", "");
    assert(strcmp(keyed.auth_key, "tskey-auth-fixture") == 0);
    assert(keyed.followup == NULL);

    ml_register_request_fields_t followup;
    ml_register_request_fields_init(&followup, node_key, old_node_key, true,
                                    "tskey-auth-spent-fixture",
                                    "https://login.tailscale.com/a/fixture");
    assert(followup.node_key == initial.node_key);
    assert(memcmp(followup.node_key, initial.node_key, sizeof(node_key)) == 0);
    assert(followup.old_node_key == old_node_key);
    assert(followup.auth_key == NULL);
    assert(strcmp(followup.followup, "https://login.tailscale.com/a/fixture") == 0);
}

static void test_response_fixtures(void) {
    const ml_register_response_fields_t auth_url = {
        .auth_url = "https://login.tailscale.com/a/fixture",
    };
    assert(ml_register_classify_response(&auth_url) == ML_REGISTER_NEEDS_AUTH);

    const ml_register_response_fields_t authorized = {
        .machine_authorized_present = true,
        .machine_authorized = true,
    };
    assert(ml_register_classify_response(&authorized) == ML_REGISTER_OK);

    const ml_register_response_fields_t approval = {
        .machine_authorized_present = true,
        .machine_authorized = false,
    };
    assert(ml_register_classify_response(&approval) == ML_REGISTER_NEEDS_APPROVAL);

    const ml_register_response_fields_t expired = {.node_key_expired = true};
    assert(ml_register_classify_response(&expired) == ML_REGISTER_NODE_KEY_EXPIRED);

    const ml_register_response_fields_t error = {.error = "fixture error"};
    assert(ml_register_classify_response(&error) == ML_REGISTER_FATAL);

    const ml_register_response_fields_t initial_timeout = {.timed_out = true};
    assert(ml_register_classify_response(&initial_timeout) == ML_REGISTER_RETRY);

    const ml_register_response_fields_t followup_timeout = {
        .timed_out = true,
        .followup_active = true,
    };
    assert(ml_register_classify_response(&followup_timeout) == ML_REGISTER_NEEDS_AUTH);

    const ml_register_response_fields_t approval_timeout = {
        .timed_out = true,
        .followup_active = true,
        .approval_pending = true,
    };
    assert(ml_register_classify_response(&approval_timeout) == ML_REGISTER_NEEDS_APPROVAL);

    const ml_register_response_fields_t precedence = {
        .error = "fixture error",
        .node_key_expired = true,
        .auth_url = "https://login.tailscale.com/a/ignored",
    };
    assert(ml_register_classify_response(&precedence) == ML_REGISTER_FATAL);
}

int main(void) {
    test_request_fixtures();
    test_response_fixtures();
    puts("Register codec fixtures: OK");
    return 0;
}
