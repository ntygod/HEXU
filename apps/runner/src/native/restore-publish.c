#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

/* A deliberately narrow Linux primitive. fd 3 is an already pinned destination
 * parent; fd 4 is the staged directory. No shell, copy, overwrite or fallback.
 * Exit 20 is the ONLY known-not-published result. Any other error is uncertain. */
static int leaf(const char *s) {
  return s[0] && strlen(s) <= 255 && !strchr(s, '/') &&
         strcmp(s, ".") && strcmp(s, "..");
}
static int local_fs(int fd) {
  struct statfs s;
  if (fstatfs(fd, &s)) return 0;
  /* ext*, XFS, Btrfs, tmpfs and overlayfs; reject NFS/FUSE/network semantics. */
  return s.f_type == 0xef53 || s.f_type == 0x58465342 ||
         s.f_type == 0x9123683e || s.f_type == 0x01021994 ||
         s.f_type == 0x794c7630;
}
static int refused(void) {
  puts("not_published");
  return 20;
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) {
    puts("hexu-restore-publish-v1");
    return 0;
  }
  struct stat parent, staged, named;
  if (getuid() != geteuid() || fstat(3, &parent) ||
      !S_ISDIR(parent.st_mode) || parent.st_uid != geteuid() ||
      (parent.st_mode & 0022) || !local_fs(3)) return refused();
  if (argc == 2 && !strcmp(argv[1], "--check")) {
    puts("supported_parent");
    return 0;
  }
  if (argc != 3 || !leaf(argv[1]) || !leaf(argv[2]) ||
      strncmp(argv[1], ".hexu-restore-", 14) || !strcmp(argv[1], argv[2]) ||
      fstat(4, &staged) || !S_ISDIR(staged.st_mode) ||
      staged.st_uid != geteuid() || (staged.st_mode & 0077) ||
      fstatat(3, argv[1], &named, AT_SYMLINK_NOFOLLOW) ||
      !S_ISDIR(named.st_mode) || named.st_dev != staged.st_dev ||
      named.st_ino != staged.st_ino) return refused();
  if (renameat2(3, argv[1], 3, argv[2], RENAME_NOREPLACE)) return refused();
  /* The rename has happened. Do not label a subsequent sync failure as absent. */
  if (fsync(3)) {
    puts("published_sync_unknown");
    return 21;
  }
  puts("published");
  return 0;
}
