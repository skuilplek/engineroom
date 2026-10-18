#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/un.h>
#endif

/* Prints "pid uid gid" for the peer of the socket inherited on fd 3. */
int main(void) {
#if defined(__linux__)
  struct ucred cred;
  socklen_t len = sizeof(cred);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &cred, &len) < 0) return 1;
  if (printf("%d %d %d\n", cred.pid, cred.uid, cred.gid) < 0) return 1;
  return 0;
#elif defined(__APPLE__)
  uid_t uid = 0;
  gid_t gid = 0;
  pid_t pid = 0;
  socklen_t pidLen = sizeof(pid);
  if (getpeereid(3, &uid, &gid) < 0) return 1;
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidLen) < 0) pid = 0;
  if (printf("%d %u %u\n", (int)pid, (unsigned)uid, (unsigned)gid) < 0) return 1;
  return 0;
#else
  return 1;
#endif
}
