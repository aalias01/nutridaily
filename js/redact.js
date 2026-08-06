/* NutriDaily screenshot redact: drag opaque black boxes, flatten to JPEG. */
window.Redact = (() => {
  'use strict';

  const MAX_EDGE = 1600;
  const JPEG_Q = 0.85;

  /**
   * @param {File|Blob} fileOrBlob
   * @param {{ maxEdge?: number }} [opts]
   * @returns {Promise<{ blob: Blob, width: number, height: number }|null>}
   *   null if user cancelled. Never returns the original file.
   */
  function open(fileOrBlob, opts) {
    const maxEdge = (opts && opts.maxEdge) || MAX_EDGE;
    return new Promise(resolve => {
      const url = URL.createObjectURL(fileOrBlob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        mountEditor(img, maxEdge, resolve);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function mountEditor(img, maxEdge, resolve) {
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const bw = Math.max(1, Math.round(img.naturalWidth * scale));
    const bh = Math.max(1, Math.round(img.naturalHeight * scale));

    const root = document.createElement('div');
    root.className = 'redact-overlay';
    root.innerHTML =
      '<div class="redact-banner">Drag to cover personal details before sending.</div>' +
      '<div class="redact-stage"><canvas id="redact-canvas"></canvas></div>' +
      '<div class="redact-toolbar">' +
        '<button type="button" class="btn ghost" id="redact-undo">Undo</button>' +
        '<button type="button" class="btn ghost" id="redact-clear">Clear</button>' +
        '<button type="button" class="btn ghost" id="redact-cancel">Cancel</button>' +
        '<button type="button" class="btn" id="redact-done">Done</button>' +
      '</div>';
    document.body.appendChild(root);
    document.body.classList.add('redact-open');

    const canvas = root.querySelector('#redact-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = bw;
    canvas.height = bh;

    const rects = [];
    let draft = null;
    let drawing = false;

    function paint() {
      ctx.clearRect(0, 0, bw, bh);
      ctx.drawImage(img, 0, 0, bw, bh);
      ctx.fillStyle = '#000';
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      if (draft) {
        ctx.fillRect(draft.x, draft.y, draft.w, draft.h);
      }
    }
    paint();

    function canvasPoint(ev) {
      const r = canvas.getBoundingClientRect();
      const sx = bw / r.width;
      const sy = bh / r.height;
      const clientX = ev.clientX != null ? ev.clientX : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : 0);
      const clientY = ev.clientY != null ? ev.clientY : (ev.touches && ev.touches[0] ? ev.touches[0].clientY : 0);
      return {
        x: Math.max(0, Math.min(bw, (clientX - r.left) * sx)),
        y: Math.max(0, Math.min(bh, (clientY - r.top) * sy))
      };
    }

    function normRect(a, b) {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    }

    let start = null;

    function onDown(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      ev.preventDefault();
      drawing = true;
      start = canvasPoint(ev);
      draft = { x: start.x, y: start.y, w: 0, h: 0 };
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      paint();
    }
    function onMove(ev) {
      if (!drawing || !start) return;
      ev.preventDefault();
      draft = normRect(start, canvasPoint(ev));
      paint();
    }
    function onUp(ev) {
      if (!drawing) return;
      drawing = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      if (draft && draft.w >= 4 && draft.h >= 4) rects.push(draft);
      draft = null;
      start = null;
      paint();
    }

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    function teardown() {
      document.body.classList.remove('redact-open');
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    root.querySelector('#redact-undo').addEventListener('click', () => {
      rects.pop();
      paint();
    });
    root.querySelector('#redact-clear').addEventListener('click', () => {
      rects.length = 0;
      paint();
    });
    root.querySelector('#redact-cancel').addEventListener('click', () => {
      teardown();
      resolve(null);
    });
    root.querySelector('#redact-done').addEventListener('click', () => {
      paint();
      canvas.toBlob(blob => {
        teardown();
        if (!blob) { resolve(null); return; }
        resolve({ blob, width: bw, height: bh });
      }, 'image/jpeg', JPEG_Q);
    });
  }

  return { open };
})();
