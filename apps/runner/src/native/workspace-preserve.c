#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

/* fd3: pinned original parent; fd4: pinned private preservation parent;
 * fd5: original directory; fd6: its original ordinary .git directory.
 * Move the whole directory, never copy/delete/chmod or follow its children.
 * This is NOT a conditional-inode rename: callers must stop all writers and
 * preserve uncertainty. The old restore-publish protocol is not expanded. */
static int leaf(const char *s) {
  if (!s[0] || strlen(s) > 255 || strchr(s, '/') || strchr(s, '\\') ||
      !strcmp(s, ".") || !strcmp(s, "..") || !strcasecmp(s, ".git")) return 0;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++)
    if (*p < 32 || *p == 127) return 0;
  return 1;
}
static int local_fs(int fd) {
  struct statfs s;
  if (fstatfs(fd, &s)) return 0;
  return s.f_type == 0xef53 || s.f_type == 0x58465342 ||
         s.f_type == 0x9123683e || s.f_type == 0x01021994 || s.f_type == 0x794c7630;
}
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int named(int fd, const char *name, const struct stat *expected) {
  struct stat s;
  return !fstatat(fd, name, &s, AT_SYMLINK_NOFOLLOW) && S_ISDIR(s.st_mode) && same(&s, expected);
}
static int absent(int fd, const char *name) {
  struct stat s;
  return fstatat(fd, name, &s, AT_SYMLINK_NOFOLLOW) && errno == ENOENT;
}
static int refused(void) { puts("not_moved"); return 20; }
static int unknown(void) { puts("move_unknown"); return 21; }
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("hexu-workspace-preserve-v1"); return 0;
  }
  struct stat source_parent, target_parent, root, git;
  if (argc != 3 || !leaf(argv[1]) || !leaf(argv[2]) || getuid() != geteuid() ||
      fstat(3, &source_parent) || fstat(4, &target_parent) || fstat(5, &root) || fstat(6, &git) ||
      !S_ISDIR(source_parent.st_mode) || !S_ISDIR(target_parent.st_mode) ||
      !S_ISDIR(root.st_mode) || !S_ISDIR(git.st_mode) ||
      source_parent.st_uid != geteuid() || target_parent.st_uid != geteuid() ||
      root.st_uid != geteuid() || git.st_uid != geteuid() ||
      (source_parent.st_mode & 0022) || (target_parent.st_mode & 0077) ||
      (root.st_mode & 0077) || (git.st_mode & 0077) ||
      source_parent.st_dev != target_parent.st_dev || source_parent.st_dev != root.st_dev ||
      root.st_dev != git.st_dev || !local_fs(3) || !local_fs(4) ||
      !named(3, argv[1], &root) || !named(5, ".git", &git) || !absent(4, argv[2])) return refused();
  if (renameat2(3, argv[1], 4, argv[2], RENAME_NOREPLACE)) {
    /* Do not turn an I/O/interruption/resource failure into proof of absence. */
    switch (errno) {
      case EEXIST: case ENOTEMPTY: case EXDEV: case EINVAL: case ENOENT:
      case EACCES: case EPERM: case ENOTDIR: case EBUSY: case EROFS:
      case ENAMETOOLONG: case ELOOP: case ENOSYS: case EOPNOTSUPP:
        return refused();
      default: return unknown();
    }
  }
  /* A successful rename may already be visible even when sync/verification
   * fails. Never attempt rollback or unlink either location. */
  if (fsync(3) || fsync(4) || !named(4, argv[2], &root) ||
      !named(5, ".git", &git) || !absent(3, argv[1])) return unknown();
  puts("preserved"); return 0;
}
