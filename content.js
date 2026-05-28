/**
 * Netflix Gizle - icerik scripti
 *
 * Netflix sayfasindaki her dizi/film kartina hover'da gizleme butonu enjekte eder,
 * gizlenen icerikleri tum Netflix sayfalarindan (anasayfa, arama, tur sayfalari)
 * MutationObserver ile otomatik olarak kaldirir.
 *
 * Veriler chrome.storage.local'de tutulur; popup ile senkronize calisir.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'hiddenTitles';
  const HIDDEN_CLASS = 'nf-hidden';
  const INJECTED_ATTR = 'data-nf-hide-injected';
  const TITLE_ID_ATTR = 'data-nf-title-id';

  // Netflix farkli sayfalarda farkli kart yapilari kullaniyor; hepsini kapsa
  const CARD_SELECTORS = [
    '.title-card',
    '.title-card-container',
    '.titleCard',
    '.title-card-tile',
    '.slider-item',
    '[data-uia="title-card"]',
    '[data-uia="title-card-container"]',
    '.search-title',
    '.galleryLockups .title-card'
  ];

  // Netflix kart hover'inda buyuk onizleme modal'i (jawbone) acar; o da hedeflenmeli
  // yoksa kullanici kartin × butonuna ulasamadan modal acilip butonu ortuyor.
  const PREVIEW_MODAL_SELECTORS = [
    '.previewModal',
    '.previewModal--container',
    '[data-uia="preview-modal-container"]',
    '[data-uia="preview-modal"]',
    '.jawBoneContainer'
  ];

  const CARD_SELECTOR = CARD_SELECTORS.concat(PREVIEW_MODAL_SELECTORS).join(',');
  const PREVIEW_MODAL_SELECTOR = PREVIEW_MODAL_SELECTORS.join(',');

  // Kartin gizlenmesi gereken ust slot wrapper'lari (varsa).
  // Sadece en yakin parent degil, tum ata zinciri taranir; slider-item gibi
  // dis slot wrapper'i kapatmazsak Netflix'in slider'inda bos yer kalir.
  const PARENT_HIDE_SELECTORS = [
    '.slider-item',
    '[class*="slider-item"]',
    '[data-uia="title-card-container"]',
    '.title-card-container',
    '.lolomoPreviewImage',
    '.galleryLockup--container',
    '.galleryLockup'
  ];
  const PARENT_HIDE_SELECTOR = PARENT_HIDE_SELECTORS.join(',');

  let hiddenIds = new Set();
  // Preview modal acildiginda kendi linklerinden ID/baslik cikaramazsak kullanilacak fallback
  let lastHoveredId = null;
  let lastHoveredTitle = null;

  // Modal'daki ses/oynat/kapat gibi UI butonlarinin aria-label'larini baslik sanmamak icin filtre
  const UI_LABEL_PATTERN = /^(turn\s+audio|mute|unmute|play\b|pause|more\s+info|close|done|sesi|ses\s+|oynat|kapat|durdur|bilgi)/i;
  const isUiLabel = (text) => !text || UI_LABEL_PATTERN.test(text.trim());

  // Bir karttan Netflix title ID'sini cikar
  const extractTitleId = (element) => {
    const link = element.querySelector('a[href*="/watch/"], a[href*="/title/"]');
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/(?:watch|title)\/(\d+)/);
      if (match) return match[1];
    }
    const dataItem = element.querySelector('[data-item-id]');
    if (dataItem) {
      const id = dataItem.getAttribute('data-item-id');
      if (id) return id;
    }
    // Bazi kartlarda kendi uzerinde data-id olabiliyor
    const ownId = element.getAttribute('data-item-id') || element.getAttribute('data-id');
    if (ownId) return ownId;
    return null;
  };

  // Popup'ta gostermek icin baslik metnini cikar.
  // Onem sirasi: title-treatment logo > video-title text > UI olmayan img alt > UI olmayan aria-label.
  const extractTitleText = (element) => {
    // 1) Modal'in buyuk baslik logosu (en guvenilir kaynak)
    const treatment = element.querySelector(
      'img.title-treatment-logo, ' +
      '[data-uia="title-treatment-logo"] img, ' +
      '.previewModal--player-titleTreatment-logo img, ' +
      '.title-treatment img'
    );
    if (treatment && treatment.alt && treatment.alt.trim()) return treatment.alt.trim();

    // 2) Yazi tabanli baslik elementleri
    const titleEl = element.querySelector(
      '.video-title-text, .video-title h4, .video-title, .fallback-text'
    );
    if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();

    // 3) UI butonu olmayan ilk img[alt]
    const imgs = element.querySelectorAll('img[alt]');
    for (const img of imgs) {
      const text = img.alt.trim();
      if (text && !isUiLabel(text)) return text;
    }

    // 4) UI butonu olmayan ilk aria-label
    const ariaEls = element.querySelectorAll('[aria-label]');
    for (const el of ariaEls) {
      const text = (el.getAttribute('aria-label') || '').trim();
      if (text && !isUiLabel(text)) return text;
    }

    return 'Unknown title';
  };

  // Bir element'in tum eslesen slot atalarini bul (en yakindan en uzaga)
  const findAncestorSlots = (card) => {
    const slots = [];
    let node = card.parentElement;
    while (node && node !== document.body) {
      if (node.matches && node.matches(PARENT_HIDE_SELECTOR)) slots.push(node);
      node = node.parentElement;
    }
    return slots;
  };

  // Karti ve TUM ust slot wrapper'larini gizle (slider-item'a kadar)
  const hideCard = (card) => {
    card.classList.add(HIDDEN_CLASS);
    findAncestorSlots(card).forEach((slot) => slot.classList.add(HIDDEN_CLASS));
  };

  // Karti tekrar goster (popup'tan geri getirildiginde)
  const showCard = (card) => {
    card.classList.remove(HIDDEN_CLASS);
    findAncestorSlots(card).forEach((slot) => slot.classList.remove(HIDDEN_CLASS));
  };

  // Storage'a yeni gizleme kaydet
  const persistHide = (id, title) => {
    chrome.storage.local.get({ [STORAGE_KEY]: {} }, (data) => {
      const map = data[STORAGE_KEY] || {};
      map[id] = { title, hiddenAt: Date.now() };
      chrome.storage.local.set({ [STORAGE_KEY]: map });
    });
  };

  // Karta veya preview modal'a gizleme butonu ekle
  const injectButton = (card) => {
    if (card.hasAttribute(INJECTED_ATTR)) return;

    const isModal = card.matches(PREVIEW_MODAL_SELECTOR);

    // Modal'da link bulunamazsa son hover edilen kart ID'sini fallback kullan
    let titleId = extractTitleId(card);
    if (!titleId && isModal) titleId = lastHoveredId;
    if (!titleId) {
      // ID henuz lazy-load edilmemis olabilir; bir sonraki mutation'da yeniden denesin
      return;
    }

    card.setAttribute(INJECTED_ATTR, '1');
    card.setAttribute(TITLE_ID_ATTR, titleId);

    // Kart hover'inda son ID/baslik'i guncelle (modal acilinca fallback olarak kullanilir)
    if (!isModal) {
      card.addEventListener('mouseenter', () => {
        lastHoveredId = titleId;
        const text = extractTitleText(card);
        if (text && text !== 'Unknown title') lastHoveredTitle = text;
      });
    }

    if (hiddenIds.has(titleId)) {
      hideCard(card);
      return;
    }

    const btn = document.createElement('button');
    btn.className = isModal ? 'nf-hide-btn nf-hide-btn--modal' : 'nf-hide-btn';
    btn.type = 'button';
    btn.title = 'Hide this title';
    btn.setAttribute('aria-label', 'Hide this title from lists');
    // SVG ile X cizimi; font glyph'inin baseline kaymasini onler, her boyutta tam merkezde durur.
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
      'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6 L18 18 M18 6 L6 18"/></svg>';

    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      let titleText = extractTitleText(card);
      // Modal'da extraction "Bilinmeyen" donerse hover edilen kartin basligini kullan
      if (isModal && (!titleText || titleText === 'Unknown title') && lastHoveredTitle) {
        titleText = lastHoveredTitle;
      }
      hiddenIds.add(titleId);
      hideCard(card);
      // Modal'da tikladiysa, ayni titleId'ye sahip butun kartlari da gizle
      document.querySelectorAll('[' + TITLE_ID_ATTR + '="' + titleId + '"]').forEach(hideCard);
      persistHide(titleId, titleText);
    });

    card.appendChild(btn);
  };

  // Sayfa veya yeni yuklenen container'daki tum kartlari isle
  const processCards = (root) => {
    const scope = root || document;
    const cards = scope.querySelectorAll(CARD_SELECTOR);
    cards.forEach(injectButton);
    // Halihazirda gizlenmeleri uygula (yeni gelen kartlar dahil)
    cards.forEach((card) => {
      const id = card.getAttribute(TITLE_ID_ATTR) || extractTitleId(card);
      if (id && hiddenIds.has(id)) hideCard(card);
    });
  };

  // Storage'dan baslangic verisini yukle
  const loadHidden = (callback) => {
    chrome.storage.local.get({ [STORAGE_KEY]: {} }, (data) => {
      const map = data[STORAGE_KEY] || {};
      hiddenIds = new Set(Object.keys(map));
      if (callback) callback();
    });
  };

  // DOM degisiklilerini izle - Netflix infinite scroll ve lazy load yapar
  const observer = new MutationObserver((mutations) => {
    let needsProcess = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches && node.matches(CARD_SELECTOR)) {
          needsProcess = true;
          break;
        }
        if (node.querySelector && node.querySelector(CARD_SELECTOR)) {
          needsProcess = true;
          break;
        }
      }
      if (needsProcess) break;
    }
    if (needsProcess) processCards();
  });

  // Popup'tan veya baska tab'dan gelen degisiklikleri uygula
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const newMap = changes[STORAGE_KEY].newValue || {};
    hiddenIds = new Set(Object.keys(newMap));
    document.querySelectorAll('[' + TITLE_ID_ATTR + ']').forEach((card) => {
      const id = card.getAttribute(TITLE_ID_ATTR);
      if (hiddenIds.has(id)) {
        hideCard(card);
      } else {
        showCard(card);
      }
    });
    // Henuz buton enjekte edilmemis kartlar varsa onlari da kontrol et
    processCards();
  });

  // Baslangic
  loadHidden(() => {
    processCards();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
