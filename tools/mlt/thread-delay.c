// Test-only (never in the runtime image): LD_PRELOAD into melt to hold the main thread back
// CF_THREAD_DELAY_US microseconds after it starts a thread, as a busy machine can, so the new
// thread runs first. Unpatched, MLT 7.30's avformat consumer then writes no frames: its thread
// sees "running" unset and ends before melt sets it (tools/mlt/consumer-start-race.patch).
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdlib.h>
#include <unistd.h>

int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*f)(void *), void *arg) {
  static int (*real)(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
  if (!real) real = dlsym(RTLD_NEXT, "pthread_create");
  int r = real(t, a, f, arg);
  const char *d = getenv("CF_THREAD_DELAY_US");
  if (d && gettid() == getpid()) usleep(atoi(d));
  return r;
}
