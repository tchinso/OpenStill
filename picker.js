(() => {
  const INSTANCE_KEY = '__openStillPickerInstance__';

  if (globalThis[INSTANCE_KEY]) {
    globalThis[INSTANCE_KEY].activate();
    return;
  }

  const MAX_HIGHLIGHTS = 20;
  const MAX_SELECTIONS = 20;
  const SELECTOR_SEARCH = Object.freeze({
    quick: { queryBudget: 120, beamWidth: 18, maxParts: 3 },
    full: { queryBudget: 700, beamWidth: 56, maxParts: 5 }
  });
  const selectorCache = new WeakMap();

  function cleanText(value, maxLength = 10_000) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function escapeCss(value) {
    if (globalThis.CSS?.escape) {
      return globalThis.CSS.escape(String(value));
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.codePointAt(0).toString(16)} `);
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\A ')
      .replace(/\r/g, '');
  }

  function isStableClass(className) {
    return className.length >= 2
      && className.length <= 60
      && !/^(?:css|sc|jsx|emotion|chakra|mantine|v)-/i.test(className)
      && !/(?:^|[-_])\d{4,}(?:$|[-_])/.test(className)
      && !/[A-F0-9]{8,}/i.test(className);
  }

  function hasSingleMatch(selector, element) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  }

  function escapeCssString(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\A ')
      .replace(/\r/g, '');
  }

  function isSemanticIdentifier(value) {
    return value.length >= 2
      && value.length <= 72
      && !/^(?:css|sc|jsx|emotion|chakra|mantine|jss|mui|svelte|v)-/i.test(value)
      && !/(?:^|[-_])\d{4,}(?:$|[-_])/.test(value)
      && !/[a-f0-9]{8,}/i.test(value)
      && !/^[\d_-]+$/.test(value);
  }

  function isSemanticClass(value) {
    return isSemanticIdentifier(value) && !/[/:]/.test(value) && !/^_/.test(value);
  }

  function isSafeSelectorAttribute(value) {
    return value.length >= 1
      && value.length <= 80
      && !/\s{3,}/.test(value)
      && !/[a-f0-9]{12,}/i.test(value);
  }

  function elementChildPosition(element) {
    if (!element.parentElement) return null;
    return [...element.parentElement.children].indexOf(element) + 1;
  }

  function elementTypePosition(element) {
    if (!element.parentElement) return null;
    return [...element.parentElement.children]
      .filter((sibling) => sibling.localName === element.localName)
      .indexOf(element) + 1;
  }

  function partialClassFragments(className) {
    const fragments = new Set();
    if (className.includes(':')) {
      const prefix = className.split(':')[0];
      if (prefix.length >= 4 && prefix.length <= 28 && isSemanticIdentifier(prefix)) {
        fragments.add(prefix);
      }
    }
    for (const part of className.split(/[._:]+/)) {
      if (part.length >= 4 && part.length <= 24 && !/\//.test(part) && isSemanticIdentifier(part)) {
        fragments.add(part);
      }
    }
    return [...fragments];
  }

  function addSelectorFeature(features, css, cost) {
    if (!css || css.length > 180) return;
    const prior = features.get(css);
    if (!prior || cost < prior.cost) {
      features.set(css, { css, cost });
    }
  }

  function selectorFeatures(element, maxFeatures = 20) {
    const tag = element.localName?.toLowerCase();
    if (!tag || tag.startsWith('openstill-')) return [];
    const features = new Map();

    if (element.id && isSemanticIdentifier(element.id)) {
      addSelectorFeature(features, '#' + escapeCss(element.id), 0.7);
    }

    const attributeNames = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id', 'name', 'role', 'type', 'for'];
    for (const name of attributeNames) {
      const value = element.getAttribute(name);
      if (value && isSafeSelectorAttribute(value)) {
        const attribute = '[' + name + "='" + escapeCssString(value) + "']";
        addSelectorFeature(features, attribute, 2.2);
        addSelectorFeature(features, tag + attribute, 2.8);
      }
    }

    const stableClasses = [...element.classList].filter(isSemanticClass);
    for (const className of stableClasses) {
      const cssClass = '.' + escapeCss(className);
      addSelectorFeature(features, cssClass, 3.1);
      addSelectorFeature(features, tag + cssClass, 3.9);
    }
    for (let index = 0; index < Math.min(stableClasses.length, 5); index += 1) {
      for (let next = index + 1; next < Math.min(stableClasses.length, 5); next += 1) {
        addSelectorFeature(features, '.' + escapeCss(stableClasses[index]) + '.' + escapeCss(stableClasses[next]), 5.1);
      }
    }

    for (const className of element.classList) {
      for (const fragment of partialClassFragments(className)) {
        const partial = "[class*='" + escapeCssString(fragment) + "']";
        addSelectorFeature(features, partial, 5.8);
        addSelectorFeature(features, tag + partial, 6.4);
      }
    }

    const childPosition = elementChildPosition(element);
    const typePosition = elementTypePosition(element);
    if (childPosition === 1) {
      addSelectorFeature(features, tag + ':first-child', 8.2);
    } else if (element.parentElement?.lastElementChild === element) {
      addSelectorFeature(features, tag + ':last-child', 8.5);
    } else if (childPosition) {
      addSelectorFeature(features, tag + ':nth-child(' + childPosition + ')', 14 + Math.min(childPosition, 8) * 0.3);
    }
    if (typePosition === 1 && childPosition !== 1) {
      addSelectorFeature(features, tag + ':first-of-type', 10.8);
    } else if (typePosition && typePosition > 1) {
      addSelectorFeature(features, tag + ':nth-of-type(' + typePosition + ')', 15 + Math.min(typePosition, 8) * 0.3);
    }
    addSelectorFeature(features, tag, 12);

    const ordered = [...features.values()]
      .sort((left, right) => left.cost - right.cost || left.css.length - right.css.length || left.css.localeCompare(right.css));
    const positional = ordered.filter((feature) => /:(?:first|last)(?:-of-type|-child)?|:nth-(?:child|of-type)\(/.test(feature.css));
    const ordinary = ordered.filter((feature) => !positional.includes(feature));
    return [...ordinary.slice(0, Math.max(1, maxFeatures - positional.length)), ...positional]
      .sort((left, right) => left.cost - right.cost || left.css.length - right.css.length || left.css.localeCompare(right.css));
  }

  function inspectCandidate(selector, target, cache, budget) {
    if (cache.has(selector)) return cache.get(selector);
    if (budget.used >= budget.limit || selector.length > 340) {
      return { containsTarget: false, count: 0 };
    }
    budget.used += 1;
    try {
      const matches = document.querySelectorAll(selector);
      const result = { containsTarget: target.matches(selector), count: matches.length };
      cache.set(selector, result);
      return result;
    } catch {
      const result = { containsTarget: false, count: 0 };
      cache.set(selector, result);
      return result;
    }
  }

  function candidateIsBetter(candidate, best) {
    if (!best) return true;
    if (candidate.cost !== best.cost) return candidate.cost < best.cost;
    if (candidate.css.length !== best.css.length) return candidate.css.length < best.css.length;
    return candidate.css.localeCompare(best.css) < 0;
  }

  function strictSelectorFallback(element) {
    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
      const tag = current.localName?.toLowerCase() || '*';
      if (current.id) {
        parts.unshift('#' + escapeCss(current.id));
        break;
      }
      const position = elementChildPosition(current);
      parts.unshift(position ? tag + ':nth-child(' + position + ')' : tag);
      if (current === document.documentElement) break;
    }
    return parts.join(' > ');
  }

  function selectorFor(element, { quick = false } = {}) {
    if (!(element instanceof Element) || element.getRootNode() !== document || !document.documentElement.contains(element)) {
      return '';
    }

    const cached = selectorCache.get(element) ?? {};
    if (!quick && cached.full && hasSingleMatch(cached.full, element)) return cached.full;
    if (quick && cached.quick && hasSingleMatch(cached.quick, element)) return cached.quick;
    if (quick && cached.full && hasSingleMatch(cached.full, element)) return cached.full;

    const config = quick ? SELECTOR_SEARCH.quick : SELECTOR_SEARCH.full;
    const maxFeatures = quick ? 14 : 24;
    const path = [];
    for (let current = element; current && path.length < 9; current = current.parentElement) {
      path.push(current);
      if (current === document.body) break;
    }
    const queryCache = new Map();
    const budget = { used: 0, limit: config.queryBudget };
    let best = null;
    let frontier = [];

    for (const feature of selectorFeatures(element, maxFeatures)) {
      const inspection = inspectCandidate(feature.css, element, queryCache, budget);
      if (!inspection.containsTarget) continue;
      const state = { css: feature.css, cost: feature.cost, outerIndex: 0, count: inspection.count };
      if (inspection.count === 1) {
        if (candidateIsBetter(state, best)) best = state;
      } else {
        frontier.push(state);
      }
    }

    const visited = new Set(frontier.map((state) => state.css));
    for (let round = 1; frontier.length && round < config.maxParts && budget.used < budget.limit; round += 1) {
      const next = [];
      const ranked = frontier
        .sort((left, right) => left.cost + Math.log2(left.count + 1) - (right.cost + Math.log2(right.count + 1)))
        .slice(0, config.beamWidth);
      for (const state of ranked) {
        for (let pathIndex = state.outerIndex + 1; pathIndex < path.length; pathIndex += 1) {
          for (const feature of selectorFeatures(path[pathIndex], maxFeatures)) {
            const connectors = [' '];
            if (pathIndex === state.outerIndex + 1) connectors.push(' > ');
            for (const connector of connectors) {
              const css = feature.css + connector + state.css;
              if (visited.has(css)) continue;
              visited.add(css);
              const inspection = inspectCandidate(css, element, queryCache, budget);
              if (!inspection.containsTarget) continue;
              const nextState = {
                css,
                cost: state.cost + feature.cost + (connector === ' > ' ? 2.1 : 0.55),
                outerIndex: pathIndex,
                count: inspection.count
              };
              if (inspection.count === 1) {
                if (candidateIsBetter(nextState, best)) best = nextState;
              } else {
                next.push(nextState);
              }
            }
          }
          if (budget.used >= budget.limit) break;
        }
      }
      frontier = next
        .sort((left, right) => left.cost + Math.log2(left.count + 1) - (right.cost + Math.log2(right.count + 1)))
        .slice(0, config.beamWidth);
    }

    const selector = best?.css || strictSelectorFallback(element);
    cached[quick ? 'quick' : 'full'] = selector;
    selectorCache.set(element, cached);
    return selector;
  }

  class OpenStillPicker {
    constructor() {
      this.mode = 'idle';
      this.saved = false;
      this.saving = false;
      this.hoveredElement = null;
      this.selectedElement = null;
      this.selections = [];
      this.activeSelectionIndex = -1;
      this.matchElements = [];
      this.host = document.createElement('openstill-picker-root');
      this.host.setAttribute('aria-hidden', 'true');
      this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      this.shadow = this.host.attachShadow({ mode: 'closed' });
      this.render();
      document.documentElement.append(this.host);

      this.onPointerMove = this.onPointerMove.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onViewportChange = this.onViewportChange.bind(this);
    }

    render() {
      this.shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; }
          .layer { position: fixed; inset: 0; pointer-events: none; }
          .match { position: fixed; border: 2px solid #22c58b; background: rgb(34 197 139 / 12%); border-radius: 4px; box-shadow: 0 0 0 1px rgb(12 54 44 / 24%); }
          .match.primary { border-color: #3b82f6; background: rgb(59 130 246 / 14%); }
          .tooltip { position: fixed; max-width: min(440px, calc(100vw - 32px)); padding: 8px 10px; border-radius: 9px; background: #111b29; color: #f8fbff; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; box-shadow: 0 12px 28px rgb(0 0 0 / 25%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .panel { position: fixed; right: 18px; bottom: 18px; width: min(448px, calc(100vw - 36px)); pointer-events: auto; color: #eaf0fa; background: #162131; border: 1px solid rgb(170 196 227 / 23%); border-radius: 16px; box-shadow: 0 20px 60px rgb(4 10 18 / 45%); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
          .topline { display: flex; align-items: center; gap: 9px; padding: 13px 14px; background: linear-gradient(120deg, #1d2d43, #152331); }
          .brand { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: #36d399; color: #10201c; font-size: 15px; font-weight: 900; }
          .heading { flex: 1; min-width: 0; }
          .heading strong { display: block; font-size: 13px; letter-spacing: .01em; }
          .heading span { display: block; margin-top: 2px; color: #aebed2; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          button { appearance: none; border: 0; border-radius: 8px; cursor: pointer; font: inherit; }
          button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #74a7ff; outline-offset: 2px; }
          .icon-button { width: 28px; height: 28px; color: #c6d4e6; background: transparent; font-size: 18px; }
          .icon-button:hover { background: rgb(255 255 255 / 10%); }
          .body { padding: 14px; }
          .hint { margin: 0; color: #d3deec; font-size: 13px; line-height: 1.5; }
          .hint b { color: #54e0aa; }
          .form[hidden], .tooltip[hidden] { display: none; }
          .form { display: grid; gap: 12px; }
          .notice { margin: 0; color: #aebed2; font-size: 12px; line-height: 1.45; }
          label { display: grid; gap: 6px; color: #c8d5e6; font-size: 12px; font-weight: 650; }
          input, select { width: 100%; min-width: 0; border: 1px solid #42546b; border-radius: 8px; background: #0f1825; color: #f4f8ff; padding: 9px 10px; font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
          input[name="name"], input[name="labels"] { font-family: inherit; }
          .selector-row { display: flex; gap: 8px; }
          .selector-row input { flex: 1; }
          .validity { padding: 8px 10px; border-radius: 8px; background: #0f1825; color: #aebed2; font-size: 12px; line-height: 1.45; }
          .validity.ok { color: #77edbd; }
          .validity.error { color: #ff9c90; }
          .preview { max-height: 66px; overflow: auto; margin-top: 5px; color: #d8e3f2; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
          .selection-summary { margin: 0; color: #b9c9dc; font-size: 12px; font-weight: 720; }
          .selection-list { display: grid; gap: 6px; max-height: 154px; overflow: auto; }
          .selection-item { display: grid; grid-template-columns: 1fr auto; gap: 7px; align-items: center; padding: 8px; border: 1px solid #32465f; border-radius: 8px; background: #101a29; }
          .selection-item.active { border-color: #4f8fff; background: #13243b; }
          .selection-item button { text-align: left; color: #d8e6f6; background: transparent; min-width: 0; }
          .selection-item .selection-css { display: block; overflow: hidden; color: #a9c8fb; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
          .selection-item .selection-text { display: block; overflow: hidden; margin-top: 2px; color: #8498b0; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
          .remove-selection { width: 26px; height: 26px; color: #ffb5ad !important; border-radius: 6px; font-size: 16px; text-align: center !important; }
          .match.selected { border-color: #42dda3; background: rgb(66 221 163 / 10%); }
          .schedule { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          .schedule label { color: #aebed2; }
          .schedule small { color: #7e91aa; font-weight: 500; }
          .actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 2px; }
          .actions .right { display: flex; gap: 8px; }
          .button { padding: 9px 11px; color: #d8e5f5; background: #2b3a50; font-size: 12px; font-weight: 700; }
          .button:hover { background: #354963; }
          .button.primary { color: #052218; background: #42dda3; }
          .button.primary:hover { background: #62e8b6; }
          .button:disabled { cursor: not-allowed; opacity: .48; }
          .message { min-height: 16px; margin: 0; color: #ffb1a9; font-size: 12px; }
          @media (max-width: 520px) { .panel { right: 10px; bottom: 10px; width: calc(100vw - 20px); } }
        </style>
        <div class="layer" id="highlightLayer"></div>
        <div class="tooltip" id="tooltip" hidden></div>
        <section class="panel" aria-label="OpenStill 요소 선택기">
          <div class="topline">
            <div class="brand">✓</div>
            <div class="heading"><strong>OpenStill</strong><span id="subtitle">추적할 요소를 가리킨 뒤 클릭하세요</span></div>
            <button class="icon-button" id="close" type="button" aria-label="선택기 닫기">×</button>
          </div>
          <div class="body">
            <p class="hint" id="pickHint"><b>선택 모드</b> · 마우스를 올리면 선택자가 보입니다. Esc를 누르면 닫습니다.</p>
            <form class="form" id="form" hidden novalidate>
              <p class="notice">요소를 여러 개 고른 뒤 한 번에 저장할 수 있습니다. 각 선택자는 하나의 요소에만 일치해야 합니다.</p>
              <p class="selection-summary" id="selectionSummary">선택한 요소 0개</p>
              <div class="selection-list" id="selectionList"></div>
              <label>CSS 선택자
                <div class="selector-row"><input id="selector" autocomplete="off" spellcheck="false" /></div>
              </label>
              <div class="validity" id="validity">선택자를 확인하는 중입니다.</div>
              <label>표시 이름 <span style="font-weight:500;color:#7e91aa">여러 개면 번호를 붙여 저장</span><input id="name" name="name" maxlength="120" /></label>
              <label>라벨 <span style="font-weight:500;color:#7e91aa">쉼표로 여러 개를 구분</span><input id="labels" name="labels" maxlength="500" placeholder="예: 채용, 가격" /></label>
              <label>확인 간격
                <div class="schedule">
                  <label><small>일</small><select id="days" aria-label="일"></select></label>
                  <label><small>시간</small><select id="hours" aria-label="시간"></select></label>
                </div>
              </label>
              <p class="notice" id="intervalSummary">매 1시간마다 확인합니다.</p>
              <p class="message" id="message" role="alert"></p>
              <div class="actions">
                <button class="button" id="selectAgain" type="button">요소 추가</button>
                <div class="right"><button class="button" id="cancel" type="button">취소</button><button class="button primary" id="save" type="submit">추적 저장</button></div>
              </div>
            </form>
          </div>
        </section>
      `;

      this.highlightLayer = this.shadow.querySelector('#highlightLayer');
      this.tooltip = this.shadow.querySelector('#tooltip');
      this.form = this.shadow.querySelector('#form');
      this.pickHint = this.shadow.querySelector('#pickHint');
      this.subtitle = this.shadow.querySelector('#subtitle');
      this.selectorInput = this.shadow.querySelector('#selector');
      this.nameInput = this.shadow.querySelector('#name');
      this.labelsInput = this.shadow.querySelector('#labels');
      this.daysInput = this.shadow.querySelector('#days');
      this.hoursInput = this.shadow.querySelector('#hours');
      this.validity = this.shadow.querySelector('#validity');
      this.intervalSummary = this.shadow.querySelector('#intervalSummary');
      this.message = this.shadow.querySelector('#message');
      this.saveButton = this.shadow.querySelector('#save');
      this.selectionSummary = this.shadow.querySelector('#selectionSummary');
      this.selectionList = this.shadow.querySelector('#selectionList');

      for (let day = 0; day <= 14; day += 1) {
        const option = document.createElement('option');
        option.value = String(day);
        option.textContent = `${day}일`;
        this.daysInput.append(option);
      }
      for (let hour = 0; hour < 24; hour += 1) {
        const option = document.createElement('option');
        option.value = String(hour);
        option.textContent = `${hour}시간`;
        this.hoursInput.append(option);
      }
      this.hoursInput.value = '1';

      this.closeButton = this.shadow.querySelector('#close');
      this.cancelButton = this.shadow.querySelector('#cancel');
      this.selectAgainButton = this.shadow.querySelector('#selectAgain');
      this.closeButton.addEventListener('click', () => this.destroy());
      this.cancelButton.addEventListener('click', () => this.destroy());
      this.selectAgainButton.addEventListener('click', () => this.beginPicking());
      this.selectorInput.addEventListener('input', () => this.validateSelector());
      this.selectionList.addEventListener('click', (event) => {
        const removeButton = event.target.closest('[data-remove-selection]');
        if (removeButton) {
          this.removeSelection(Number(removeButton.dataset.removeSelection));
          return;
        }
        const selectionButton = event.target.closest('[data-selection-index]');
        if (selectionButton) {
          this.activateSelection(Number(selectionButton.dataset.selectionIndex));
        }
      });
      this.daysInput.addEventListener('change', () => this.updateInterval());
      this.hoursInput.addEventListener('change', () => this.updateInterval());
      this.form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.save();
      });
    }

    activate() {
      if (this.mode !== 'picking') {
        this.beginPicking();
      }
    }

    beginPicking() {
      if (this.saving) {
        return;
      }
      this.mode = 'picking';
      this.hoveredElement = null;
      this.form.hidden = true;
      this.pickHint.hidden = false;
      this.subtitle.textContent = this.selections.length ? '추가할 요소를 가리킨 뒤 클릭하세요' : '추적할 요소를 가리킨 뒤 클릭하세요';
      this.pickHint.textContent = this.selections.length
        ? '추가 선택 모드 · 원하는 요소를 클릭하면 목록에 더해집니다. Esc를 누르면 닫습니다.'
        : '선택 모드 · 마우스를 올리면 선택자가 보입니다. Esc를 누르면 닫습니다.';
      this.message.textContent = '';
      this.clearHighlights();
      this.tooltip.hidden = true;
      window.addEventListener('mousemove', this.onPointerMove, true);
      window.addEventListener('click', this.onClick, true);
      window.addEventListener('keydown', this.onKeyDown, true);
      window.addEventListener('scroll', this.onViewportChange, true);
      window.addEventListener('resize', this.onViewportChange, true);
    }

    stopPicking() {
      window.removeEventListener('mousemove', this.onPointerMove, true);
      window.removeEventListener('click', this.onClick, true);
    }

    elementFromEvent(event) {
      const path = event.composedPath?.() ?? [event.target];
      if (path.includes(this.host)) {
        return null;
      }
      return path.find((node) => node instanceof Element && node !== this.host && !this.host.contains(node)) ?? null;
    }

    onPointerMove(event) {
      const element = this.elementFromEvent(event);
      if (!element || element === this.hoveredElement) {
        return;
      }
      this.hoveredElement = element;
      const selector = selectorFor(element, { quick: true });
      if (!selector) {
        this.clearHighlights();
        return;
      }
      this.matchElements = [element];
      this.renderHighlights();
      this.showTooltip(element, selector);
    }

    onClick(event) {
      const element = this.elementFromEvent(event);
      if (!element) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.selectElement(element);
    }

    onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.destroy();
      }
    }

    onViewportChange() {
      this.renderHighlights();
      if (this.mode === 'picking' && this.hoveredElement) {
        this.showTooltip(this.hoveredElement, selectorFor(this.hoveredElement, { quick: true }));
      }
    }

    currentSelection() {
      return this.selections[this.activeSelectionIndex] ?? null;
    }

    renderSelectionList() {
      this.selectionSummary.textContent = '선택한 요소 ' + this.selections.length + '개';
      this.saveButton.textContent = this.selections.length > 1 ? this.selections.length + '개 추적 저장' : '추적 저장';
      this.selectionList.replaceChildren();

      this.selections.forEach((selection, index) => {
        const item = document.createElement('div');
        item.className = 'selection-item' + (index === this.activeSelectionIndex ? ' active' : '');
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.dataset.selectionIndex = String(index);
        const css = document.createElement('span');
        css.className = 'selection-css';
        css.textContent = selection.selector;
        const preview = document.createElement('span');
        preview.className = 'selection-text';
        preview.textContent = cleanText(selection.text, 130) || '(텍스트 없음)';
        selectButton.append(css, preview);
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'remove-selection';
        removeButton.dataset.removeSelection = String(index);
        removeButton.setAttribute('aria-label', (index + 1) + '번째 선택 삭제');
        removeButton.textContent = '×';
        item.append(selectButton, removeButton);
        this.selectionList.append(item);
      });
    }

    activateSelection(index) {
      if (this.saving || !Number.isInteger(index) || !this.selections[index]) return;
      this.activeSelectionIndex = index;
      const selection = this.selections[index];
      this.selectedElement = selection.element;
      this.selectorInput.value = selection.selector;
      this.matchElements = selection.element ? [selection.element] : [];
      this.renderSelectionList();
      this.validateSelector();
    }

    removeSelection(index) {
      if (!Number.isInteger(index) || !this.selections[index] || this.saving) return;
      this.selections.splice(index, 1);
      if (!this.selections.length) {
        this.activeSelectionIndex = -1;
        this.selectedElement = null;
        this.beginPicking();
        return;
      }
      this.activeSelectionIndex = Math.min(index, this.selections.length - 1);
      this.activateSelection(this.activeSelectionIndex);
    }

    showEditor() {
      this.stopPicking();
      this.mode = 'editing';
      this.pickHint.hidden = true;
      this.form.hidden = false;
      this.subtitle.textContent = '선택자를 확인하고 추적 정보를 저장하세요';
      const selection = this.currentSelection();
      if (!selection) {
        this.beginPicking();
        return;
      }
      this.selectedElement = selection.element;
      this.selectorInput.value = selection.selector;
      if (!this.nameInput.value) {
        this.nameInput.value = cleanText(document.title, 100) || selection.element.localName.toLowerCase() + ' 요소';
      }
      this.tooltip.hidden = true;
      this.renderSelectionList();
      this.updateInterval();
    }

    selectElement(element) {
      const selector = selectorFor(element);
      if (!selector) {
        this.message.textContent = '이 요소는 표준 CSS 선택자로 안전하게 저장할 수 없습니다.';
        return;
      }
      let matches;
      try {
        matches = [...document.querySelectorAll(selector)];
      } catch {
        this.message.textContent = '생성한 CSS 선택자를 검증하지 못했습니다.';
        return;
      }
      if (matches.length !== 1 || matches[0] !== element) {
        this.message.textContent = '정확히 하나의 요소를 가리키는 선택자를 만들지 못했습니다.';
        return;
      }

      const existingIndex = this.selections.findIndex((selection) => selection.element === element || selection.selector === selector);
      if (existingIndex >= 0) {
        this.activeSelectionIndex = existingIndex;
      } else {
        if (this.selections.length >= MAX_SELECTIONS) {
          this.showEditor();
          this.message.textContent = '한 번에 선택할 수 있는 요소는 최대 ' + MAX_SELECTIONS + '개입니다.';
          return;
        }
        this.selections.push({
          element,
          selector,
          text: cleanText(element.textContent),
          matchCount: 1
        });
        this.activeSelectionIndex = this.selections.length - 1;
      }
      this.matchElements = [element];
      this.showEditor();
      this.selectorInput.focus();
      this.selectorInput.select();
    }

    clearHighlights() {
      this.matchElements = [];
      this.renderHighlights();
    }

    renderHighlights() {
      this.highlightLayer.replaceChildren();
      const drawn = new Set();
      const draw = (element, classes) => {
        if (!element?.isConnected || drawn.has(element)) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width && !rect.height) return;
        const box = document.createElement('div');
        box.className = classes;
        box.style.left = Math.max(0, rect.left) + 'px';
        box.style.top = Math.max(0, rect.top) + 'px';
        box.style.width = Math.max(0, rect.width) + 'px';
        box.style.height = Math.max(0, rect.height) + 'px';
        this.highlightLayer.append(box);
        drawn.add(element);
      };

      this.selections.slice(0, MAX_HIGHLIGHTS).forEach((selection, index) => {
        draw(selection.element, 'match selected' + (index === this.activeSelectionIndex ? ' primary' : ''));
      });
      this.matchElements.slice(0, MAX_HIGHLIGHTS).forEach((element, index) => {
        draw(element, 'match' + (index === 0 ? ' primary' : ''));
      });
    }

    showTooltip(element, selector) {
      if (!selector || !element.isConnected) {
        this.tooltip.hidden = true;
        return;
      }
      const rect = element.getBoundingClientRect();
      const description = `${element.localName.toLowerCase()} · ${selector}`;
      this.tooltip.textContent = description;
      this.tooltip.hidden = false;
      const top = Math.min(window.innerHeight - 38, Math.max(8, rect.top - 34));
      const left = Math.min(window.innerWidth - 32, Math.max(8, rect.left));
      this.tooltip.style.top = `${top}px`;
      this.tooltip.style.left = `${left}px`;
    }

    updateInterval() {
      const days = Number(this.daysInput.value);
      let hours = Number(this.hoursInput.value);
      if (days === 14 && hours !== 0) {
        hours = 0;
        this.hoursInput.value = '0';
      }
      [...this.hoursInput.options].forEach((option) => {
        option.disabled = days === 14 && Number(option.value) > 0;
      });
      const totalHours = days * 24 + hours;
      this.intervalSummary.textContent = totalHours >= 1 && totalHours <= 336
        ? `매 ${days ? `${days}일 ` : ''}${hours ? `${hours}시간` : ''}`.trim() + '마다 확인합니다.'
        : '간격은 최소 1시간, 최대 14일로 설정해 주세요.';
      this.validateSelector();
    }

    selectedIntervalHours() {
      return Number(this.daysInput.value) * 24 + Number(this.hoursInput.value);
    }

    validateSelector() {
      if (this.saving) {
        return false;
      }
      const selector = this.selectorInput.value.trim();
      const totalHours = this.selectedIntervalHours();
      const active = this.currentSelection();
      this.message.textContent = '';
      this.validity.className = 'validity';
      this.clearHighlights();

      if (!active) {
        this.validity.textContent = '먼저 추적할 요소를 선택해 주세요.';
        this.validity.classList.add('error');
        this.saveButton.disabled = true;
        return false;
      }
      if (!selector) {
        this.validity.textContent = 'CSS 선택자를 입력해 주세요.';
        this.validity.classList.add('error');
        this.saveButton.disabled = true;
        return false;
      }

      try {
        const matches = [...document.querySelectorAll(selector)];
        this.matchElements = matches;
        this.renderHighlights();
        if (matches.length !== 1) {
          this.validity.textContent = matches.length + '개 요소와 일치합니다. 정확히 1개가 되도록 선택자를 다듬어 주세요.';
          this.validity.classList.add('error');
          this.saveButton.disabled = true;
          return false;
        }

        active.selector = selector;
        active.element = matches[0];
        active.text = cleanText(matches[0].textContent);
        active.matchCount = 1;
        this.selectedElement = matches[0];
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = active.text.slice(0, 700) || '(텍스트 없음)';
        this.validity.replaceChildren(document.createTextNode('1개 요소와 일치합니다.'), preview);
        this.validity.classList.add('ok');
        this.renderSelectionList();
        this.saveButton.disabled = !(totalHours >= 1 && totalHours <= 336 && this.selections.length);
        return true;
      } catch (error) {
        this.validity.textContent = '유효하지 않은 CSS 선택자입니다: ' + error.message;
        this.validity.classList.add('error');
        this.saveButton.disabled = true;
        return false;
      }
    }

    validateAllSelections() {
      if (!this.selections.length) {
        this.message.textContent = '최소 한 개의 요소를 선택해 주세요.';
        return false;
      }
      const seenSelectors = new Set();
      const seenElements = new Set();
      for (let index = 0; index < this.selections.length; index += 1) {
        const selection = this.selections[index];
        if (seenSelectors.has(selection.selector)) {
          this.activeSelectionIndex = index;
          this.selectorInput.value = selection.selector;
          this.message.textContent = '같은 CSS 선택자가 두 번 포함되어 있습니다.';
          this.renderSelectionList();
          return false;
        }
        seenSelectors.add(selection.selector);
        try {
          const matches = [...document.querySelectorAll(selection.selector)];
          if (matches.length !== 1) {
            this.activeSelectionIndex = index;
            this.selectorInput.value = selection.selector;
            this.message.textContent = (index + 1) + '번째 선택자가 현재 ' + matches.length + '개 요소와 일치합니다.';
            this.renderSelectionList();
            this.validateSelector();
            return false;
          }
          if (seenElements.has(matches[0])) {
            this.activeSelectionIndex = index;
            this.selectorInput.value = selection.selector;
            this.message.textContent = (index + 1) + '번째 선택자는 이미 고른 실제 요소와 겹칩니다.';
            this.matchElements = [matches[0]];
            this.renderHighlights();
            this.validity.textContent = '이미 선택한 실제 요소와 겹치는 CSS 선택자입니다.';
            this.validity.className = 'validity error';
            this.saveButton.disabled = true;
            this.renderSelectionList();
            return false;
          }
          seenElements.add(matches[0]);
          selection.element = matches[0];
          selection.text = cleanText(matches[0].textContent);
          selection.matchCount = 1;
        } catch (error) {
          this.activeSelectionIndex = index;
          this.selectorInput.value = selection.selector;
          this.message.textContent = (index + 1) + '번째 CSS 선택자가 유효하지 않습니다: ' + error.message;
          this.renderSelectionList();
          return false;
        }
      }
      this.activeSelectionIndex = Math.min(Math.max(this.activeSelectionIndex, 0), this.selections.length - 1);
      this.selectorInput.value = this.selections[this.activeSelectionIndex].selector;
      this.matchElements = [this.selections[this.activeSelectionIndex].element];
      this.renderHighlights();
      this.renderSelectionList();
      return true;
    }

    async save() {
      if (this.saving) {
        return;
      }
      if (!this.validateSelector() || !this.validateAllSelections()) {
        return;
      }
      const totalHours = this.selectedIntervalHours();
      if (totalHours < 1 || totalHours > 336) {
        this.message.textContent = '간격은 최소 1시간, 최대 14일입니다.';
        return;
      }

      this.saving = true;
      this.saveButton.disabled = true;
      this.closeButton.disabled = true;
      this.cancelButton.disabled = true;
      this.selectAgainButton.disabled = true;
      this.message.style.color = '#aebed2';
      this.message.textContent = this.selections.length + '개 요소의 기준 텍스트를 저장하는 중입니다…';

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'create-monitors',
          url: location.href,
          pageTitle: document.title,
          name: this.nameInput.value,
          labels: this.labelsInput.value.split(','),
          intervalHours: totalHours,
          items: this.selections.map((selection) => ({
            selector: selection.selector,
            text: selection.text,
            matchCount: selection.matchCount
          }))
        });
        if (!response?.ok) {
          throw new Error(response?.error || '저장에 실패했습니다.');
        }
        this.saved = true;
        this.saving = false;
        this.message.style.color = '#77edbd';
        this.message.textContent = (response.count || this.selections.length) + '개 요소를 저장했습니다. 다음 확인 시 변경 여부를 알려드릴게요.';
        this.subtitle.textContent = '추적이 시작되었습니다';
        setTimeout(() => this.destroy(), 1_100);
      } catch (error) {
        this.saving = false;
        this.message.style.color = '#ffb1a9';
        this.message.textContent = error.message || '저장에 실패했습니다.';
        this.saveButton.disabled = false;
        this.closeButton.disabled = false;
        this.cancelButton.disabled = false;
        this.selectAgainButton.disabled = false;
      }
    }

    destroy() {
      if (this.saving) {
        return;
      }
      this.stopPicking();
      window.removeEventListener('keydown', this.onKeyDown, true);
      window.removeEventListener('scroll', this.onViewportChange, true);
      window.removeEventListener('resize', this.onViewportChange, true);
      if (!this.saved) {
        void chrome.runtime.sendMessage({ type: 'release-unclaimed-origin', url: location.href }).catch(() => undefined);
      }
      this.host.remove();
      delete globalThis[INSTANCE_KEY];
    }
  }

  const instance = new OpenStillPicker();
  globalThis[INSTANCE_KEY] = instance;
  instance.activate();
})();
