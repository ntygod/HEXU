#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdio.h>
/* Explicit disposable-fixture interposer. Product helper invokes no hook and
 * production launch clears LD_PRELOAD. Only the test supplies this library. */
static int renamed = 0;
static void user_file(int dir, const char *name, int exclusive) {
  int fd = openat(dir, name, O_WRONLY | O_CREAT | (exclusive ? O_EXCL : O_TRUNC), 0600);
  if (fd < 0 || write(fd, "USER RACE", 9) != 9 || close(fd)) _exit(90);
}
int renameat2(int olddir, const char *oldname, int newdir, const char *newname, unsigned flags) {
  int (*real_rename)(int, const char *, int, const char *, unsigned) = dlsym(RTLD_NEXT, "renameat2");
  const char *mode = getenv("HEXU_DISPOSABLE_RACE");
  if (!real_rename || !mode) _exit(91);
  int target = flags == RENAME_EXCHANGE ? newdir : olddir;
  const char *name = flags == RENAME_EXCHANGE ? newname : oldname;
  if (!strcmp(mode, "edit")) user_file(target, name, 0);
  if (!strcmp(mode, "replace")) {
    if (renameat(target, name, target, "fixture-original-moved")) _exit(92);
    user_file(target, name, 1);
  }
  if (!strcmp(mode, "occupied-backup")) user_file(newdir, newname, 1);
  if (!strcmp(mode, "replace-stage")) {
    if (renameat(olddir, oldname, olddir, "fixture-stage-moved")) _exit(93);
    user_file(olddir, oldname, 1);
  }
  if (!strcmp(mode, "unsupported")) { errno = EXDEV; return -1; }
  int result = real_rename(olddir, oldname, newdir, newname, flags);
  if (!result) renamed = 1;
  if (!result && !strcmp(mode, "exit-after-rename")) _exit(86);
  return result;
}
int fsync(int fd) {
  int (*real_sync)(int) = dlsym(RTLD_NEXT, "fsync");
  const char *mode = getenv("HEXU_DISPOSABLE_RACE");
  if (renamed && mode && !strcmp(mode, "sync-failed")) { errno = EIO; return -1; }
  return real_sync(fd);
}
