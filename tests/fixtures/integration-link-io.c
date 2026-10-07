#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Test-only interposition, loaded solely for a disposable helper invocation.
 * The after case performs the real syscall before returning the injected EIO. */
int linkat(int source_dir, const char *source, int target_dir,
           const char *target, int flags) {
  int (*real_linkat)(int, const char *, int, const char *, int) =
    dlsym(RTLD_NEXT, "linkat");
  if (!real_linkat) _exit(87);
  const char *fault = getenv("HEXU_DISPOSABLE_LINK_IO");
  if (fault && !strcmp(fault, "before")) { errno = EIO; return -1; }
  if (fault && !strcmp(fault, "occupied")) {
    int fd = openat(target_dir, target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    const char bytes[] = "USER RACE\n";
    if (fd < 0 || write(fd, bytes, sizeof bytes - 1) != (ssize_t)(sizeof bytes - 1)) _exit(88);
    close(fd);
  }
  int result = real_linkat(source_dir, source, target_dir, target, flags);
  if (result == 0 && fault && !strcmp(fault, "after")) { errno = EIO; return -1; }
  return result;
}
