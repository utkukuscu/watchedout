/**
 * Netflix Gizle - popup mantigi
 *
 * Gizlenen icerikleri tarih sirasiyla listeler, tek tek veya hepsini birden geri getirir.
 * chrome.storage.local'i tek dogru kaynak olarak kullanir; degisiklikler otomatik yansir.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'hiddenTitles';

  const listEl = document.getElementById('list');
  const emptyEl = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const clearAllBtn = document.getElementById('clearAll');

  const render = (map) => {
    const entries = Object.entries(map).sort((a, b) => {
      return (b[1].hiddenAt || 0) - (a[1].hiddenAt || 0);
    });

    countEl.textContent = String(entries.length);
    listEl.textContent = '';

    if (entries.length === 0) {
      emptyEl.hidden = false;
      clearAllBtn.disabled = true;
      return;
    }

    emptyEl.hidden = true;
    clearAllBtn.disabled = false;

    const fragment = document.createDocumentFragment();
    for (const [id, info] of entries) {
      const li = document.createElement('li');
      li.className = 'list__item';

      const title = document.createElement('span');
      title.className = 'list__title';
      const text = (info && info.title) ? info.title : 'Title #' + id;
      title.textContent = text;
      title.title = text;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'list__restore';
      btn.textContent = 'Restore';
      btn.addEventListener('click', () => restoreOne(id));

      li.appendChild(title);
      li.appendChild(btn);
      fragment.appendChild(li);
    }
    listEl.appendChild(fragment);
  };

  const load = () => {
    chrome.storage.local.get({ [STORAGE_KEY]: {} }, (data) => {
      render(data[STORAGE_KEY] || {});
    });
  };

  const restoreOne = (id) => {
    chrome.storage.local.get({ [STORAGE_KEY]: {} }, (data) => {
      const map = data[STORAGE_KEY] || {};
      delete map[id];
      chrome.storage.local.set({ [STORAGE_KEY]: map }, load);
    });
  };

  clearAllBtn.addEventListener('click', () => {
    const confirmed = window.confirm(
      'All hidden titles will be restored. Continue?'
    );
    if (!confirmed) return;
    chrome.storage.local.set({ [STORAGE_KEY]: {} }, load);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    render(changes[STORAGE_KEY].newValue || {});
  });

  load();
})();
