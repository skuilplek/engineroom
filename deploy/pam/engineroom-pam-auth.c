#define _GNU_SOURCE
#include <security/pam_appl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * stdin frames: uint32be length + bytes, username then password.
 * Exit 0 on success, 1 on auth failure, 2 on a bad request.
 * The password is never written to argv or stdout.
 */

static char *password = NULL;

static int conv(int num, const struct pam_message **msg, struct pam_response **resp, void *appdata) {
  (void)appdata;
  struct pam_response *replies = calloc((size_t)num, sizeof(*replies));
  if (!replies) return PAM_BUF_ERR;
  for (int i = 0; i < num; i++) {
    switch (msg[i]->msg_style) {
      case PAM_PROMPT_ECHO_OFF:
        replies[i].resp = strdup(password ? password : "");
        if (!replies[i].resp) {
          free(replies);
          return PAM_BUF_ERR;
        }
        break;
      case PAM_PROMPT_ECHO_ON:
        replies[i].resp = strdup("");
        break;
      case PAM_ERROR_MSG:
      case PAM_TEXT_INFO:
        break;
      default:
        free(replies);
        return PAM_CONV_ERR;
    }
  }
  *resp = replies;
  return PAM_SUCCESS;
}

static int read_frame(char **out, size_t max) {
  unsigned char header[4];
  if (fread(header, 1, 4, stdin) != 4) return -1;
  uint32_t len = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                 ((uint32_t)header[2] << 8) | (uint32_t)header[3];
  if (len == 0 || len > max) return -1;
  char *buf = calloc(1, (size_t)len + 1);
  if (!buf) return -1;
  if (fread(buf, 1, len, stdin) != len) {
    explicit_bzero(buf, len);
    free(buf);
    return -1;
  }
  *out = buf;
  return 0;
}

static int username_ok(const char *user) {
  if (!user || !user[0]) return 0;
  for (const char *p = user; *p; p++) {
    char c = *p;
    int ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (!ok) return 0;
  }
  return 1;
}

int main(void) {
  char *user = NULL;
  if (read_frame(&user, 32) != 0 || read_frame(&password, 1024) != 0 || !username_ok(user)) {
    if (password) {
      explicit_bzero(password, strlen(password));
      free(password);
    }
    free(user);
    return 2;
  }

  struct pam_conv conversation = {conv, NULL};
  pam_handle_t *pamh = NULL;
  int rc = pam_start("engineroom", user, &conversation, &pamh);
  if (rc == PAM_SUCCESS) {
    rc = pam_authenticate(pamh, 0);
    if (rc == PAM_SUCCESS) rc = pam_acct_mgmt(pamh, 0);
    pam_end(pamh, rc);
  }

  explicit_bzero(password, strlen(password));
  free(password);
  free(user);
  return rc == PAM_SUCCESS ? 0 : 1;
}
