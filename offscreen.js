(() => {
  let audioContext;

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40000);
  }

  function copyOpeningTagAttributes(markup, tagName, target) {
    const openingTag = String(markup).match(new RegExp(`<${tagName}\\b([^>]*)>`, 'i'));
    if (!openingTag) return;

    const attributeTemplate = document.createElement('template');
    attributeTemplate.innerHTML = `<openstill-attributes ${openingTag[1]}></openstill-attributes>`;
    const parsed = attributeTemplate.content.firstElementChild;
    if (!parsed) return;
    for (const attribute of parsed.attributes) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }

  function makeInertDocumentTree(html) {
    const source = String(html);
    const bodyOpening = source.match(/<body\b[^>]*>/i);
    const bodyMarkup = bodyOpening
      ? source.slice(bodyOpening.index + bodyOpening[0].length).replace(/<\/body\s*>[\s\S]*$/i, '')
      : source;
    const contentTemplate = document.createElement('template');
    contentTemplate.innerHTML = bodyMarkup;

    const root = document.createElement('openstill-inert-root');
    const htmlElement = document.createElement('html');
    const bodyElement = document.createElement('body');
    copyOpeningTagAttributes(html, 'html', htmlElement);
    copyOpeningTagAttributes(html, 'body', bodyElement);
    bodyElement.append(contentTemplate.content.cloneNode(true));
    htmlElement.append(bodyElement);
    root.append(htmlElement);
    return root;
  }

  function inspectHtml(html, selector) {
    if (typeof html !== 'string' || typeof selector !== 'string' || !selector.trim()) {
      return { ok: false, error: '검사할 HTML 또는 CSS 선택자가 올바르지 않습니다.' };
    }

    try {
      // This detached tree is never attached to a browsing context. Therefore
      // image/iframe URLs in a monitored document cannot issue follow-up requests.
      const root = makeInertDocumentTree(html);
      const fragmentSelector = selector.trim().replace(/^:root(?=\s|>|$)/, 'html');
      const matches = root.querySelectorAll(fragmentSelector);
      const firstMatch = matches[0];

      return {
        ok: true,
        exists: Boolean(firstMatch),
        matchCount: matches.length,
        text: firstMatch ? cleanText(firstMatch.textContent) : ''
      };
    } catch (error) {
      return {
        ok: false,
        error: `CSS 선택자를 해석할 수 없습니다: ${error.message}`
      };
    }
  }

  async function playAlert() {
    try {
      audioContext ??= new AudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const startAt = audioContext.currentTime + 0.02;
      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.14, startAt + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
      gain.connect(audioContext.destination);

      const first = audioContext.createOscillator();
      first.type = 'sine';
      first.frequency.setValueAtTime(880, startAt);
      first.frequency.exponentialRampToValueAtTime(1175, startAt + 0.18);
      first.connect(gain);
      first.start(startAt);
      first.stop(startAt + 0.21);

      const second = audioContext.createOscillator();
      second.type = 'sine';
      second.frequency.setValueAtTime(1319, startAt + 0.18);
      second.connect(gain);
      second.start(startAt + 0.18);
      second.stop(startAt + 0.4);
    } catch (error) {
      // A visual notification remains available when audio is unavailable.
      console.warn('OpenStill could not play its alert sound.', error);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'parse-monitor-html') {
      sendResponse(inspectHtml(message.html, message.selector));
      return;
    }

    if (message?.type === 'play-alert-sound') {
      void playAlert().finally(() => sendResponse({ ok: true }));
      return true;
    }

  });
})();
