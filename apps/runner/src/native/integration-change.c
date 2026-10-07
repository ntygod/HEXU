#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

/* fd 3 pins the target parent, fd 4 an explicitly selected private backup
 * directory on the same filesystem. Input is exact before bytes + after bytes.
 * This is NOT a content-conditioned rename: callers must stop other writers.
 * Every named material survives failure. Never retry, unlink, or reverse a
 * rename on uncertain outcome. Exit 20 means neither name was changed; 21
 * means intent/material must be preserved, including a staged replacement. */
static int refused(void) { puts("not_changed"); return 20; }
static int unknown(void) { puts("change_unknown"); return 21; }
static int local_fs(int fd) {
  struct statfs s;
  if (fstatfs(fd, &s)) return 0;
  return s.f_type == 0xef53 || s.f_type == 0x58465342 ||
         s.f_type == 0x9123683e || s.f_type == 0x01021994 ||
         s.f_type == 0x794c7630;
}
static int leaf(const char *s) {
  return s[0] && strlen(s) <= 255 && !strchr(s, '/') && !strchr(s, '\\') &&
         strcmp(s, ".") && strcmp(s, "..") && strcasecmp(s, ".git");
}
static int number(const char *s, uintmax_t *out) {
  if (!s[0] || strspn(s, "0123456789") != strlen(s)) return 0;
  char *end = NULL;
  errno = 0;
  *out = strtoumax(s, &end, 10);
  return !errno && !*end;
}
static int length(const char *s, size_t *out) {
  uintmax_t n;
  if (!number(s, &n) || n > 8 * 1024 * 1024) return 0;
  *out = (size_t)n; return 1;
}
static int same_inode(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int same_material(const struct stat *a, const struct stat *b) {
  return same_inode(a, b) && a->st_size == b->st_size &&
    a->st_mode == b->st_mode && a->st_nlink == b->st_nlink &&
    a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec;
}
static int same_stamp(const struct stat *a, const struct stat *b) {
  return same_material(a, b) && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int directories(struct stat *parent, struct stat *backup) {
  return !fstat(3, parent) && !fstat(4, backup) &&
    S_ISDIR(parent->st_mode) && S_ISDIR(backup->st_mode) &&
    parent->st_uid == geteuid() && backup->st_uid == geteuid() &&
    !(parent->st_mode & 0022) && (backup->st_mode & 07777) == 0700 &&
    !same_inode(parent, backup) && parent->st_dev == backup->st_dev &&
    local_fs(3) && local_fs(4);
}
static int regular(const struct stat *s, size_t size, const char *git_mode) {
  mode_t mode = s->st_mode & 07777;
  return S_ISREG(s->st_mode) && s->st_uid == geteuid() && s->st_nlink == 1 &&
    s->st_size == (off_t)size &&
    (mode == 0600 || mode == 0644 || mode == 0700 || mode == 0755) &&
    ((!strcmp(git_mode, "100755") && (mode & 0111)) ||
     (!strcmp(git_mode, "100644") && !(mode & 0111)));
}
static int exact_read(int fd, unsigned char *bytes, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    ssize_t n = read(fd, bytes + offset, size - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    offset += (size_t)n;
  }
  return 1;
}
static int exact_file(int fd, const unsigned char *bytes, size_t size, struct stat *observed) {
  struct stat before, after;
  if (fstat(fd, &before) || before.st_size != (off_t)size || lseek(fd, 0, SEEK_SET) < 0)
    return 0;
  unsigned char block[65536];
  size_t offset = 0;
  while (offset < size) {
    size_t want = size - offset < sizeof block ? size - offset : sizeof block;
    ssize_t n = read(fd, block, want);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0 || memcmp(block, bytes + offset, (size_t)n)) return 0;
    offset += (size_t)n;
  }
  ssize_t n;
  do { n = read(fd, block, 1); } while (n < 0 && errno == EINTR);
  if (n || fstat(fd, &after) || !same_stamp(&before, &after)) return 0;
  *observed = after; return 1;
}
static int named(int dir, const char *name, const struct stat *expected) {
  struct stat s;
  return !fstatat(dir, name, &s, AT_SYMLINK_NOFOLLOW) && same_stamp(&s, expected);
}
static int absent(int dir, const char *name) {
  struct stat s;
  return fstatat(dir, name, &s, AT_SYMLINK_NOFOLLOW) && errno == ENOENT;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("hexu-integration-change-v2"); return 0;
  }
  struct stat parent, backup, original, current, staged, saved;
  size_t before_len, after_len;
  uintmax_t dev, ino;
  if (argc != 9 || getuid() != geteuid() || !leaf(argv[1]) || !leaf(argv[2]) ||
      strncmp(argv[2], "hexu-change-", 12) || !directories(&parent, &backup) ||
      (strcmp(argv[3], "100644") && strcmp(argv[3], "100755")) ||
      (strcmp(argv[4], "100644") && strcmp(argv[4], "100755") && strcmp(argv[4], "delete")) ||
      !length(argv[5], &before_len) || !length(argv[6], &after_len) ||
      (!strcmp(argv[4], "delete") && after_len) ||
      !number(argv[7], &dev) || !number(argv[8], &ino) || !absent(4, argv[2]))
    return refused();
  const int deletion = !strcmp(argv[4], "delete");
  int source = openat(3, argv[1], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (source < 0 || fstat(source, &original) ||
      (uintmax_t)original.st_dev != dev || (uintmax_t)original.st_ino != ino ||
      !regular(&original, before_len, argv[3]) || flistxattr(source, NULL, 0) != 0)
    return refused();
  unsigned char *input = malloc(before_len + after_len + 1);
  if (!input || !exact_read(0, input, before_len + after_len)) return refused();
  unsigned char extra;
  ssize_t n;
  do { n = read(0, &extra, 1); } while (n < 0 && errno == EINTR);
  if (n || !exact_file(source, input, before_len, &current) ||
      !same_stamp(&current, &original) || !named(3, argv[1], &original) || fsync(source)) return refused();
  int replacement = -1;
  if (!deletion) {
    replacement = openat(4, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
    if (replacement < 0) return refused();
    size_t offset = 0;
    while (offset < after_len) {
      ssize_t written = write(replacement, input + before_len + offset, after_len - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) return refused();
      offset += (size_t)written;
    }
    /* Preserve ordinary read/write visibility; explicit Git executable-bit
     * changes add execute only for principals already allowed to read. */
    mode_t mode = original.st_mode & 0666;
    if (!strcmp(argv[4], "100755")) mode |= (mode & 0444) >> 2;
    if (fchmod(replacement, mode) || fsync(replacement) ||
        !exact_file(replacement, input + before_len, after_len, &staged) ||
        staged.st_nlink != 0 || flistxattr(replacement, NULL, 0) != 0) return refused();
    if (!directories(&parent, &backup) || !named(3, argv[1], &original)) return refused();
    char fd_name[64];
    snprintf(fd_name, sizeof fd_name, "/proc/self/fd/%d", replacement);
    /* A named replacement may exist even when linkat reports an I/O error.
     * EEXIST is a definite refusal; every other outcome keeps both places. */
    if (linkat(AT_FDCWD, fd_name, 4, argv[2], AT_SYMLINK_FOLLOW))
      return errno == EEXIST ? refused() : unknown();
    if (fsync(4) || fstat(replacement, &staged)) return unknown();
  }
  if (!directories(&parent, &backup) || !exact_file(source, input, before_len, &current) ||
      !same_stamp(&current, &original) || !named(3, argv[1], &original) ||
      (deletion ? !absent(4, argv[2]) : !named(4, argv[2], &staged)))
    return deletion ? refused() : unknown();
  /* RENAME_EXCHANGE is deliberately not described as compare-and-swap. A
   * noncooperating writer can race this boundary; verify both names afterwards
   * and preserve both locations rather than undoing or deleting either. */
  int r = deletion ? renameat2(3, argv[1], 4, argv[2], RENAME_NOREPLACE)
                   : renameat2(4, argv[2], 3, argv[1], RENAME_EXCHANGE);
  /* EIO is not evidence that rename left both names untouched. Keep the
   * durable file intent even when the kernel reports an I/O failure. */
  if (r) return deletion && errno != EIO ? refused() : unknown();
  if (fsync(3) || fsync(4) || !directories(&parent, &backup) ||
      !exact_file(source, input, before_len, &saved) ||
      !same_material(&saved, &original) || !regular(&saved, before_len, argv[3]) ||
      !named(4, argv[2], &saved) || flistxattr(source, NULL, 0) != 0) return unknown();
  if (deletion) {
    if (!absent(3, argv[1])) return unknown();
    printf("changed %ju:%ju deleted\n", (uintmax_t)saved.st_dev, (uintmax_t)saved.st_ino);
  } else {
    if (!exact_file(replacement, input + before_len, after_len, &current) ||
        !same_material(&current, &staged) || !regular(&current, after_len, argv[4]) ||
        !named(3, argv[1], &current) || flistxattr(replacement, NULL, 0) != 0) return unknown();
    printf("changed %ju:%ju %ju:%ju\n", (uintmax_t)saved.st_dev, (uintmax_t)saved.st_ino,
           (uintmax_t)current.st_dev, (uintmax_t)current.st_ino);
  }
  return 0;
}
