#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

/* fd 3 is the pinned existing destination directory. The anonymous inode has
 * no replaceable staging name. Only linkat publishes it, with EEXIST refusal.
 * Exit 20 proves no link was attempted/succeeded; every other error is unknown. */
static int refused(void) { puts("not_published"); return 20; }
static int local_fs(int fd) {
  struct statfs s;
  if (fstatfs(fd, &s)) return 0;
  return s.f_type == 0xef53 || s.f_type == 0x58465342 ||
         s.f_type == 0x9123683e || s.f_type == 0x01021994 ||
         s.f_type == 0x794c7630;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("hexu-integration-add-v1"); return 0;
  }
  struct stat parent, file;
  if (argc != 4 || getuid() != geteuid() || fstat(3, &parent) ||
      !S_ISDIR(parent.st_mode) || parent.st_uid != geteuid() ||
      (parent.st_mode & 0022) || !local_fs(3) || !argv[1][0] ||
      strlen(argv[1]) > 255 || strchr(argv[1], '/') || strchr(argv[1], '\\') ||
      !strcmp(argv[1], ".") || !strcmp(argv[1], "..") || !strcasecmp(argv[1], ".git"))
    return refused();
  mode_t mode;
  if (!strcmp(argv[2], "100644")) mode = 0644;
  else if (!strcmp(argv[2], "100755")) mode = 0755;
  else return refused();
  char *end = NULL;
  errno = 0;
  unsigned long length = strtoul(argv[3], &end, 10);
  if (errno || !argv[3][0] || *end || length > 8 * 1024 * 1024) return refused();
  int fd = openat(3, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
  if (fd < 0) return refused();
  unsigned char bytes[65536];
  unsigned long remaining = length;
  while (remaining) {
    size_t want = remaining < sizeof bytes ? remaining : sizeof bytes;
    ssize_t n = read(0, bytes, want);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { close(fd); return refused(); }
    ssize_t offset = 0;
    while (offset < n) {
      ssize_t written = write(fd, bytes + offset, (size_t)(n - offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) { close(fd); return refused(); }
      offset += written;
    }
    remaining -= (unsigned long)n;
  }
  ssize_t extra;
  do { extra = read(0, bytes, 1); } while (extra < 0 && errno == EINTR);
  if (extra != 0 || fchmod(fd, mode) || fsync(fd) || fstat(fd, &file) ||
      !S_ISREG(file.st_mode) || file.st_uid != geteuid() || file.st_nlink != 0 ||
      file.st_size != (off_t)length) { close(fd); return refused(); }
  if (fstat(3, &parent) || parent.st_uid != geteuid() || (parent.st_mode & 0022)) {
    close(fd); return refused();
  }
  char source[64];
  snprintf(source, sizeof source, "/proc/self/fd/%d", fd);
  if (linkat(AT_FDCWD, source, 3, argv[1], AT_SYMLINK_FOLLOW)) {
    close(fd); return refused();
  }
  if (fsync(3)) { close(fd); puts("published_sync_unknown"); return 21; }
  printf("published %ju:%ju\n", (uintmax_t)file.st_dev, (uintmax_t)file.st_ino);
  close(fd);
  return 0;
}
