'use strict';
// Central monochrome SVG icon set. Any element with data-icon="name" gets the
// icon prepended (keeping its text label, if any). No emoji, ever.

window.GWT = window.GWT || {};

(() => {
  const S = (inner) =>
    `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" ` +
    `stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const MAP = {
    close: S('<path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/>'),
    zoom: S('<path d="M4.5 1.5h-3v3M7.5 1.5h3v3M1.5 7.5v3h3M10.5 7.5v3h-3"/>'),
    popout: S('<path d="M5 2H2v8h8V7"/><path d="M6.5 5.5L10.5 1.5M7 1.5h3.5V5"/>'),
    dock: S('<path d="M5 2H2v8h8V7"/><path d="M10.5 1.5L6.5 5.5M6.5 2.5v3h3"/>'),
    stop: S('<rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>'),
    diff: S('<path d="M3.5 1.5v4M1.5 3.5h4M6.5 9h4"/>'),
    refresh: S('<path d="M10.2 6a4.2 4.2 0 1 1-1.2-2.9"/><path d="M10.6 1.2v2.6H8"/>'),
    plus: S('<path d="M6 2v8M2 6h8"/>'),
    chevsL: S('<path d="M6 2L2.5 6L6 10M10 2L6.5 6L10 10"/>'),
    chevsR: S('<path d="M6 2L9.5 6L6 10M2 2L5.5 6L2 10"/>'),
    eye: S('<path d="M1 6c1.9-2.6 8.1-2.6 10 0c-1.9 2.6-8.1 2.6-10 0z"/><circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none"/>'),
    eyeOff: S('<path d="M1 6c1.9-2.6 8.1-2.6 10 0c-1.9 2.6-8.1 2.6-10 0z"/><path d="M2 10.5L10 1.5"/>'),
    save: S('<path d="M1.5 1.5h7l2 2v7h-9z"/><path d="M4 1.5v2.5h4V1.5"/><path d="M3.5 10.5V7h5v3.5"/>'),
    send: S('<path d="M1.5 6.2L10.6 1.6L8.8 10.4L5.9 7.2z" fill="currentColor" stroke="none"/>'),
    swatch: S(
      '<rect x="0.5" y="0.5" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none"/>' +
      '<rect x="7" y="0.5" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none" opacity=".65"/>' +
      '<rect x="0.5" y="7" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none" opacity=".38"/>' +
      '<rect x="7" y="7" width="4.5" height="4.5" rx="1" fill="currentColor" stroke="none" opacity=".82"/>'
    ),
    edit: S('<path d="M8.4 1.6l2 2L4.2 9.8 1.8 10.2l.4-2.4z"/>'),
    tiles: S('<rect x="1.5" y="1.5" width="4" height="4" rx="0.5"/><rect x="6.5" y="1.5" width="4" height="4" rx="0.5"/><rect x="1.5" y="6.5" width="4" height="4" rx="0.5"/><rect x="6.5" y="6.5" width="4" height="4" rx="0.5"/>'),
    tabs: S('<path d="M1.5 4.5V3h4l1 1.5h4v6h-9z"/><path d="M1.5 4.5h9"/>'),
    keyUp: S('<path d="M6 10V2M2.8 5.2L6 2l3.2 3.2"/>'),
    keyDown: S('<path d="M6 2v8M2.8 6.8L6 10l3.2-3.2"/>'),
    keySpace: S('<path d="M2 6.5v3h8v-3"/>'),
    keyEnter: S('<path d="M10 2.5v3.5H3.5M5.5 3.8L3 6l2.5 2.2"/>'),
    keyEsc: S('<path d="M10.5 5.5v5h-5"/><path d="M6.5 5.5L2 1M2 4.5V1h3.5"/>'),
    sliders: S(
      '<path d="M1 2.5h10M1 6h10M1 9.5h10"/>' +
      '<circle cx="8" cy="2.5" r="1.7" fill="currentColor" stroke="none"/>' +
      '<circle cx="4" cy="6" r="1.7" fill="currentColor" stroke="none"/>' +
      '<circle cx="8.5" cy="9.5" r="1.7" fill="currentColor" stroke="none"/>'
    ),
  };

  function apply(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconApplied) return;
      el.dataset.iconApplied = '1';
      el.insertAdjacentHTML('afterbegin', MAP[el.dataset.icon] || '');
    });
  }

  GWT.icons = { MAP, apply };
  apply(document); // static markup
})();
