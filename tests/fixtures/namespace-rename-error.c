#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
/* Linked only into a disposable copy of a native helper. No product hook or
 * inherited environment override. AFTER models a completed rename whose result
 * is uncertain; it does not claim to reproduce an actual device/kernel fault. */
#ifndef HEXU_FIXTURE_AFTER
#error explicit fixture fault position is required
#endif
#ifndef HEXU_FIXTURE_ERRNO
#error explicit fixture errno is required
#endif
int renameat2(int od, const char *on, int nd, const char *nn, unsigned flags) {
  if (flags != RENAME_NOREPLACE)
    return (int)syscall(SYS_renameat2, od, on, nd, nn, flags);
  if (HEXU_FIXTURE_AFTER) {
    int result = (int)syscall(SYS_renameat2, od, on, nd, nn, flags);
    if (result) return result;
  }
  errno = HEXU_FIXTURE_ERRNO;
  return -1;
}
