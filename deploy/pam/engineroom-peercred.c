#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

/* Prints "pid uid gid" for the peer of the socket inherited on fd 3. */
int main(void) {
  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0) return 1;
  if (printf("%d %d %d\n", cred.pid, cred.uid, cred.gid) < 0) return 1;
  return 0;
}
