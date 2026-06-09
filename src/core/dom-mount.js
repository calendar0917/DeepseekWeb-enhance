function createMountManager(delay = 180, env = {}) {
  const mounts = new Map();
  const rootEnv = {
    setTimeout: env.setTimeout || globalThis.setTimeout,
    clearTimeout: env.clearTimeout || globalThis.clearTimeout,
    MutationObserver: env.MutationObserver || globalThis.MutationObserver,
  };
  let timer = null;
  let observer = null;

  const run = () => {
    timer = null;
    for (const mount of mounts.values()) mount();
  };

  return {
    register(id, mount) {
      mounts.set(id, mount);
      mount();
    },
    unregister(id) {
      mounts.delete(id);
    },
    schedule() {
      if (timer) rootEnv.clearTimeout(timer);
      timer = rootEnv.setTimeout(run, delay);
    },
    observe(root) {
      if (!root || !rootEnv.MutationObserver) return false;
      if (observer) observer.disconnect();
      observer = new rootEnv.MutationObserver(() => this.schedule());
      observer.observe(root, { childList: true, subtree: true });
      return true;
    },
    disconnect() {
      if (timer) rootEnv.clearTimeout(timer);
      timer = null;
      if (observer) observer.disconnect();
      observer = null;
    },
    size() {
      return mounts.size;
    },
  };
}

module.exports = { createMountManager };
