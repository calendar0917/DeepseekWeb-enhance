function createLocalStorage(storage) {
  return {
    getText(key, fallback = '') {
      const value = storage.getItem(key);
      return value == null ? fallback : value;
    },
    setText(key, value) {
      storage.setItem(key, String(value));
    },
    getJson(key, fallback) {
      try {
        const raw = storage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    setJson(key, value) {
      storage.setItem(key, JSON.stringify(value));
    },
  };
}

function createGMStorage(getValue, setValue) {
  return {
    get(key, fallback) {
      return getValue(key, fallback);
    },
    set(key, value) {
      setValue(key, value);
    },
    getList(key) {
      return String(getValue(key, '') || '')
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean);
    },
  };
}

module.exports = { createGMStorage, createLocalStorage };
