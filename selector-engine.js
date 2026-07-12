(() => {
  'use strict';

  /*
   * SelectorX is an independently authored selector synthesizer.
   *
   * The engine models a target as an ancestor route with two preceding-sibling
   * branches at each level. It ranks small selector atoms by sharedness and
   * stability, greedily adds atoms while consulting the live DOM, then prunes
   * constraints in reverse order. This deliberately describes local semantic
   * context rather than serialising an entire DOM path.
   */

  const DEFAULT_TIMEOUT_MS = 500;
  const MAX_ATTRIBUTES_PER_NODE = 15;
  const MAX_ATTRIBUTE_NAME_LENGTH = 32;
  const MAX_ATTRIBUTE_VALUE_LENGTH = 96;
  const MAX_PARTIAL_VALUES = 10;
  const IGNORED_ATTRIBUTE_NAMES = new Set([
    'style', 'srcdoc', 'nonce', 'integrity', 'xmlns', 'xmlns:xlink'
  ]);
  const SKIPPED_SIBLING_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'HEAD', 'NOSCRIPT', 'OBJECT', 'META'
  ]);
  const SEMANTIC_ATTRIBUTE_NAMES = new Set([
    'data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id',
    'name', 'role', 'type', 'for', 'aria-label', 'aria-labelledby',
    'title', 'value'
  ]);
  const CSS_VOCABULARY = new Set([
    'align', 'animate', 'animation', 'background', 'border', 'bottom',
    'box', 'column', 'color', 'container', 'display', 'flex', 'font',
    'gap', 'grid', 'height', 'hidden', 'hover', 'inline', 'justify',
    'layout', 'left', 'margin', 'max', 'min', 'opacity', 'overflow',
    'padding', 'position', 'right', 'row', 'shadow', 'size', 'space',
    'text', 'top', 'transition', 'visible', 'width'
  ]);
  const MEANINGFUL_NAMES = new Set([
    'a', 'article', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'li',
    'option', 'output', 'summary', 'td', 'th', 'tr'
  ]);

  function isElement(node) {
    return Boolean(node && node.nodeType === 1);
  }

  function isDocument(node) {
    return Boolean(node && node.nodeType === 9);
  }

  function isShadowRoot(node) {
    return Boolean(node && node.nodeType === 11 && node.host);
  }

  function asElements(input) {
    if (!input) return [];
    if (isElement(input)) return [input];
    if (typeof input[Symbol.iterator] !== 'function') return [];
    const result = [];
    const seen = new Set();
    for (const node of input) {
      if (!isElement(node) || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }
    return result;
  }

  function documentOrder(elements) {
    return [...elements].sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function escapeIdentifier(value) {
    const text = String(value);
    if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
      return globalThis.CSS.escape(text);
    }

    let escaped = '';
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const code = character.codePointAt(0);
      const safe = /[a-zA-Z0-9_-]/.test(character);
      const needsEscape = !safe
        || (index === 0 && /\d/.test(character))
        || (index === 1 && text[0] === '-' && /\d/.test(character));
      escaped += needsEscape ? '\\' + code.toString(16) + ' ' : character;
    }
    return escaped;
  }

  function escapeString(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '')
      .replace(/\n/g, '\\a ');
  }

  function hasGeneratedShape(value) {
    const text = String(value || '');
    const compact = text.replace(/[-_]/g, '');
    if (!text) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return true;
    if (compact.length === 32 && /^[a-f0-9]+$/i.test(compact)) return true;
    if (/(?:^|[-_])[a-f0-9]{10,}(?:$|[-_])/i.test(text)) return true;
    if (/(?:^|[-_])\d{4,}(?:$|[-_])/.test(text)) return true;
    if (/[a-z]\d+[a-z]/i.test(text) || /[a-z]{1,3}\d{3,}/i.test(text)) return true;
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(text)) return true;
    return false;
  }

  function isStableValue(value, { allowShort = false } = {}) {
    const text = String(value || '').trim();
    if (!text || text.length > MAX_ATTRIBUTE_VALUE_LENGTH) return false;
    if (!allowShort && text.length < 2) return false;
    return !hasGeneratedShape(text);
  }

  function isSafeAttributeName(name) {
    const text = String(name || '').toLowerCase();
    return text.length > 0
      && text.length <= MAX_ATTRIBUTE_NAME_LENGTH
      && /^[a-z_][a-z0-9_.:-]*$/i.test(text)
      && !/^on/i.test(text)
      && !text.includes(':')
      && !text.includes('xmlns')
      && !IGNORED_ATTRIBUTE_NAMES.has(text);
  }

  function childPosition(element) {
    const parent = element.parentElement;
    if (!parent) return { index: 0, count: 0 };
    const children = [...parent.children];
    return { index: children.indexOf(element) + 1, count: children.length };
  }

  function previousMeaningfulSibling(element) {
    let current = element.previousElementSibling;
    while (current && SKIPPED_SIBLING_TAGS.has(current.tagName)) {
      current = current.previousElementSibling;
    }
    return current
      ? { element: current, immediate: current === element.previousElementSibling }
      : null;
  }

  function callbackAllows(options, type, name, value, depth, offset) {
    if (typeof options.filterCallback !== 'function') return true;
    return Boolean(options.filterCallback(type, name, value, depth, offset));
  }

  function wordParts(value, { includePhrases = true, classValue = false } = {}) {
    const source = String(value || '');
    const ranked = new Map();
    const add = (part, rank) => {
      const text = String(part || '').trim();
      if (text.length < 4 || !isStableValue(text)) return;
      const existing = ranked.get(text);
      if (existing === undefined || rank < existing) ranked.set(text, rank);
    };

    if (classValue && source.includes(':')) {
      add(source.slice(0, source.indexOf(':')), 0);
    }

    const expanded = source
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
    const words = expanded.split(/[\s,_.:/()\[\]=\-]+/).filter(Boolean);

    if (includePhrases) {
      for (let index = 0; index < words.length - 1; index += 1) {
        add(words[index] + '-' + words[index + 1], 1 + index);
      }
    }
    words.forEach((word, index) => add(word, 4 + index));

    return [...ranked.entries()]
      .sort((left, right) => left[1] - right[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
      .slice(0, MAX_PARTIAL_VALUES)
      .map(([part]) => part);
  }

  function cssWordPenalty(name, value) {
    const words = String(name || '') + ' ' + String(value || '');
    const split = words.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!split.length) return 0;
    return split.filter((word) => CSS_VOCABULARY.has(word)).length / split.length;
  }

  function baseCost(kind, name, localLevel, details) {
    if (kind === 'tag') return 8.8;
    if (kind === 'pos') return 14.6 + localLevel * 0.28;
    if (kind === 'immediate') return 12.5 + localLevel * 0.4;
    if (kind === 'attribOnly') return 6.1;
    if (kind === 'attribStart') return 4.1;
    if (kind === 'attribEnd') return 4.35;
    if (kind === 'attribContain') {
      const baseline = name === 'class' ? 3.45 : 4.75;
      return baseline - Math.min(details?.partialLength || 0, 24) * 0.08;
    }
    if (kind === 'attrib') {
      if (name === 'id') return localLevel === 0 ? 0.9 : 18 + localLevel * 1.2;
      if (name === 'class') return details?.specialClass ? 5.1 : 2.35;
      if (name?.startsWith('data-')) return 1.7;
      if (SEMANTIC_ATTRIBUTE_NAMES.has(name)) return 2.45;
      return 5.2;
    }
    return 9;
  }

  class Evidence {
    constructor(fields) {
      Object.assign(this, fields);
      this.id = [
        this.type,
        this.name || '',
        this.value || '',
        this.localLevel,
        this.offset,
        this.css
      ].join('\u0001');
      this.stem = [this.type, this.name || '', this.value || '', this.offset].join('\u0001');
      this.metrics = {
        sharedRate: 0,
        targetProximity: 0,
        cssWordPenalty: 0,
        repeatedToTarget: 0,
        semanticName: 0,
        numericRisk: 0,
        specialRisk: 0
      };
      this.rankCost = this.baseCost;
    }

    asSorterToken() {
      return {
        id: this.id,
        type: this.type,
        name: this.name,
        value: this.value,
        depth: this.depth,
        offset: this.offset,
        nodeRef: this.node,
        css: this.css,
        metrics: { ...this.metrics }
      };
    }
  }

  class Route {
    constructor(target, root, options) {
      this.target = target;
      this.root = root;
      this.options = options;
      this.steps = [];
      this.evidence = [];
      this.siblingAdjacency = new Map();

      let current = target;
      while (isElement(current)) {
        this.steps.push({ element: current, localLevel: this.steps.length, depth: 0 });
        if (current === root) break;
        const parent = current.parentElement;
        if (!parent) break;
        current = parent;
      }

      this.maxDepth = Math.max(0, this.steps.length - 1);
      for (const step of this.steps) {
        step.depth = this.maxDepth - step.localLevel;
      }
      this._extract();
    }

    _add(type, name, value, css, step, offset, details = {}) {
      if (!callbackAllows(this.options, type, name, value, step.depth, offset)) return;
      // A preceding sibling beside the target is often meaningful (for
      // example, a label followed by a value). A sibling at a page-shell
      // ancestor is much more likely to encode fragile layout, so its cost
      // grows with distance from the target.
      const lanePenalty = offset < 0
        ? Math.abs(offset) * (2.2 + step.localLevel * 1.25)
        : 0;
      const evidence = new Evidence({
        type,
        name: name || '',
        value: value || '',
        css,
        node: details.node || step.element,
        localLevel: step.localLevel,
        depth: step.depth,
        offset,
        semantic: Boolean(details.semantic),
        bridge: type === 'immediate',
        baseCost: baseCost(type, name, step.localLevel, details) + lanePenalty
      });
      if (!this.evidence.some((item) => item.id === evidence.id)) {
        this.evidence.push(evidence);
      }
    }

    _extractNode(node, step, offset) {
      const tag = String(node.localName || '').toLowerCase();
      if (!tag) return;
      const nodeDetails = { node };
      this._add('tag', tag, '', escapeIdentifier(tag), step, offset, nodeDetails);

      const position = childPosition(node);
      if (position.index > 0 && position.count > 1) {
        const pseudo = position.index === 1
          ? ':first-child'
          : ':nth-child(' + position.index + ')';
        this._add('pos', tag, String(position.index), escapeIdentifier(tag) + pseudo, step, offset, nodeDetails);
      }

      const attributes = [...node.attributes].slice(0, MAX_ATTRIBUTES_PER_NODE);
      const classNames = [...node.classList].slice(0, MAX_ATTRIBUTES_PER_NODE);
      const id = node.getAttribute('id');
      if (id && isStableValue(id)) {
        this._add('attrib', 'id', id, '#' + escapeIdentifier(id), step, offset, {
          ...nodeDetails,
          semantic: true
        });
      }

      for (const className of classNames) {
        if (!isStableValue(className, { allowShort: true })) continue;
        const simple = /^[a-zA-Z_][\w-]*$/.test(className);
        const css = simple
          ? '.' + escapeIdentifier(className)
          : "[class*='" + escapeString(className) + "']";
        this._add('attrib', 'class', className, css, step, offset, {
          ...nodeDetails,
          semantic: true,
          specialClass: !simple
        });

        if (this.options.partAttrib) {
          for (const part of wordParts(className, { classValue: true })) {
            this._add('attribContain', 'class', part, "[class*='" + escapeString(part) + "']", step, offset, {
              ...nodeDetails,
              semantic: true,
              partialLength: part.length
            });
          }
        }
      }

      for (const attribute of attributes) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name === 'id' || name === 'class' || !isSafeAttributeName(name)) continue;

        const escapedName = escapeIdentifier(name);
        this._add('attribOnly', name, '', '[' + escapedName + ']', step, offset, {
          ...nodeDetails,
          semantic: name.startsWith('data-')
        });
        if (!value || !isStableValue(value, { allowShort: true })) continue;

        this._add('attrib', name, value, '[' + escapedName + "='" + escapeString(value) + "']", step, offset, {
          ...nodeDetails,
          semantic: name.startsWith('data-') || SEMANTIC_ATTRIBUTE_NAMES.has(name)
        });

        if (!this.options.partAttrib) continue;
        for (const part of wordParts(value, { includePhrases: true })) {
          const atStart = value.indexOf(part) === 0;
          const atEnd = value.lastIndexOf(part) === value.length - part.length;
          const type = atStart ? 'attribStart' : atEnd ? 'attribEnd' : 'attribContain';
          const operator = type === 'attribStart' ? '^=' : type === 'attribEnd' ? '$=' : '*=';
          this._add(type, name, part, '[' + escapedName + operator + "'" + escapeString(part) + "']", step, offset, {
            ...nodeDetails,
            semantic: name.startsWith('data-'),
            partialLength: part.length
          });
        }
      }
    }

    _extract() {
      for (const step of this.steps) {
        this._extractNode(step.element, step, 0);
        if (this.options.siblingNodes) {
          const first = previousMeaningfulSibling(step.element);
          if (first) {
            this._extractNode(first.element, step, -1);
            this.siblingAdjacency.set(`${step.localLevel}:-1`, first.immediate);
            const second = previousMeaningfulSibling(first.element);
            if (second) {
              this._extractNode(second.element, step, -2);
              this.siblingAdjacency.set(`${step.localLevel}:-2`, second.immediate);
            }
          }
        }
      }

      if (this.options.immediate) {
        for (let localLevel = 0; localLevel < this.steps.length - 1; localLevel += 1) {
          const step = this.steps[localLevel];
          this._add('immediate', '', '', '', step, 0, { node: step.element });
        }
      }
    }

    isImmediateSiblingStep(localLevel, precedingOffset, followingOffset) {
      if (followingOffset !== precedingOffset + 1) return false;
      return this.options.immediate !== false
        && this.siblingAdjacency.get(`${localLevel}:${precedingOffset}`) === true;
    }
  }

  class SelectorDraft {
    constructor(route, evidence = []) {
      this.route = route;
      this.evidence = evidence;
      this.evidenceIds = new Set(evidence.map((item) => item.id));
      this.css = this._serialize();
      this.rankCost = evidence.reduce((total, item) => total + item.rankCost, 0);
    }

    hasStemAt(localLevel) {
      return this.evidence.some((item) => (
        !item.bridge && item.localLevel === localLevel && item.offset === 0
      ));
    }

    canAdd(item) {
      if (this.evidenceIds.has(item.id)) return false;
      if (!this.evidence.length) {
        return !item.bridge && item.localLevel === 0 && item.offset === 0;
      }
      if (item.bridge) {
        return this.hasStemAt(item.localLevel) && this.hasStemAt(item.localLevel + 1);
      }
      return true;
    }

    add(item) {
      return new SelectorDraft(this.route, [...this.evidence, item]);
    }

    remove(item) {
      return new SelectorDraft(this.route, this.evidence.filter((current) => current !== item));
    }

    _compound(items) {
      if (!items.length) return '';
      const order = { tag: 0, attrib: 1, attribOnly: 2, attribStart: 3, attribEnd: 4, attribContain: 5, pos: 6 };
      return [...items]
        .sort((left, right) => (
          (order[left.type] ?? 9) - (order[right.type] ?? 9)
          || left.css.localeCompare(right.css)
        ))
        .map((item) => item.css)
        .join('');
    }

    _serialize() {
      const ordinary = this.evidence.filter((item) => !item.bridge);
      if (!ordinary.length) return '';
      const rows = new Map();
      for (const item of ordinary) {
        if (!rows.has(item.localLevel)) rows.set(item.localLevel, []);
        rows.get(item.localLevel).push(item);
      }

      const levels = [...rows.keys()].sort((left, right) => right - left);
      const parts = [];
      let priorLevel = null;
      for (const localLevel of levels) {
        const items = rows.get(localLevel);
        const laneOffsets = [...new Set(items.map((item) => item.offset))].sort((left, right) => left - right);
        let row = '';
        let priorOffset = null;
        for (const offset of laneOffsets) {
          const lane = this._compound(items.filter((item) => item.offset === offset));
          if (!lane) continue;
          if (row) {
            row += this.route.isImmediateSiblingStep(localLevel, priorOffset, offset) ? ' + ' : ' ~ ';
          }
          row += lane;
          priorOffset = offset;
        }
        if (!row) row = '*';

        if (parts.length) {
          const bridge = this.evidence.some((item) => item.bridge && item.localLevel === localLevel);
          const direct = priorLevel === localLevel + 1 && bridge;
          parts.push(direct ? ' > ' : ' ');
        }
        parts.push(row);
        priorLevel = localLevel;
      }
      return parts.join('');
    }
  }

  function rootContains(root, element) {
    if (root === element) return true;
    if (isDocument(root)) return Boolean(root.documentElement && root.documentElement.contains(element));
    return typeof root?.contains === 'function' && root.contains(element);
  }

  function normalizeOptions(value) {
    const input = isElement(value) || isDocument(value) || isShadowRoot(value)
      ? { root: value }
      : value && typeof value === 'object' ? value : {};
    const timeout = Object.prototype.hasOwnProperty.call(input, 'timeout')
      ? Number(input.timeout)
      : DEFAULT_TIMEOUT_MS;
    return {
      root: input.root || null,
      timeout: Number.isNaN(timeout) ? DEFAULT_TIMEOUT_MS : timeout,
      filterCallback: input.filterCallback,
      tokenSorter: input.tokenSorter,
      debug: Boolean(input.debug),
      partAttrib: input.partAttrib !== false,
      siblingNodes: input.siblingNodes !== false,
      immediate: input.immediate !== false
    };
  }

  function createContext(selected, options) {
    const documentNode = selected[0].ownerDocument;
    for (const element of selected) {
      if (element.ownerDocument !== documentNode) {
        throw new Error('elements do not belong to the same document');
      }
    }

    const root = options.root || documentNode.documentElement;
    const rootDocument = isDocument(root) ? root : root?.ownerDocument;
    if (rootDocument !== documentNode) {
      throw new Error('root node does not belong to the same document');
    }
    if (!root || typeof root.querySelectorAll !== 'function') {
      throw new Error('root node does not support selector queries');
    }
    for (const element of selected) {
      if (!rootContains(root, element)) {
        throw new Error('target is not in subtree of root');
      }
    }

    return {
      documentNode,
      root,
      options,
      startedAt: Date.now(),
      queryCache: new Map()
    };
  }

  function checkDeadline(context) {
    const timeout = context.options.timeout;
    if (timeout && Date.now() - context.startedAt > timeout) {
      throw new Error('Time limit exceeded while generating a CSS selector');
    }
  }

  function query(context, selector) {
    if (context.queryCache.has(selector)) return context.queryCache.get(selector);
    checkDeadline(context);
    let matches;
    try {
      matches = [...context.root.querySelectorAll(selector)];
    } catch {
      matches = [];
    }
    context.queryCache.set(selector, matches);
    return matches;
  }

  function routeStemIndex(routes) {
    const index = new Map();
    for (const route of routes) {
      const stems = new Set(route.evidence.filter((item) => !item.bridge).map((item) => item.stem));
      for (const stem of stems) {
        index.set(stem, (index.get(stem) || 0) + 1);
      }
    }
    return index;
  }

  function decorateEvidence(route, routes) {
    const stemCounts = routeStemIndex(routes);
    const rightwardCounts = new Map();
    for (const item of route.evidence.filter((entry) => !entry.bridge)) {
      const key = item.stem;
      rightwardCounts.set(key, (rightwardCounts.get(key) || 0) + 1);
    }

    for (const item of route.evidence) {
      const sharedRate = item.bridge
        ? 0
        : (stemCounts.get(item.stem) || 0) / Math.max(1, routes.length);
      const targetProximity = route.maxDepth
        ? item.depth / route.maxDepth
        : 1;
      const sameOnRoute = item.bridge ? 0 : Math.max(0, (rightwardCounts.get(item.stem) || 0) - 1);
      const numericRisk = /\d/.test(item.name + item.value) ? 1 : 0;
      const specialRisk = /[^a-zA-Z0-9 _-]/.test(item.value) ? 1 : 0;
      const semanticName = MEANINGFUL_NAMES.has(item.name) || item.name.startsWith('aria-') ? 1 : 0;
      const cssPenalty = cssWordPenalty(item.name, item.value);
      item.metrics = {
        sharedRate,
        targetProximity,
        cssWordPenalty: cssPenalty,
        repeatedToTarget: sameOnRoute,
        semanticName,
        numericRisk,
        specialRisk
      };
      item.rankCost = item.baseCost
        - sharedRate * 2.8
        - targetProximity * 0.7
        - semanticName * 0.5
        + cssPenalty * 0.65
        + sameOnRoute * 0.45
        + numericRisk * 1.6
        + specialRisk * (item.type === 'attrib' ? 0.9 : 0.25);
    }
  }

  function orderEvidence(route, routes, options) {
    decorateEvidence(route, routes);
    let ordered = [...route.evidence].sort((left, right) => (
      left.rankCost - right.rankCost
      || right.metrics.sharedRate - left.metrics.sharedRate
      || right.depth - left.depth
      || left.css.length - right.css.length
      || left.css.localeCompare(right.css)
    ));

    if (typeof options.tokenSorter === 'function') {
      const tokens = ordered.map((item) => item.asSorterToken());
      const supplied = options.tokenSorter(tokens);
      if (supplied && typeof supplied.then === 'function') {
        if (options.debug) {
          console.warn('[OpenStill SelectorX] asynchronous tokenSorter is not available in the synchronous picker path.');
        }
      } else if (Array.isArray(supplied)) {
        const byId = new Map(ordered.map((item) => [item.id, item]));
        const reordered = supplied
          .map((token) => byId.get(typeof token === 'string' ? token : token?.id))
          .filter(Boolean);
        const remainder = ordered.filter((item) => !reordered.includes(item));
        ordered = [...reordered, ...remainder];
      }
    }
    return ordered;
  }

  function describeMatches(matches, pending) {
    const covered = [];
    const foreign = [];
    for (const node of matches) {
      if (pending.has(node)) covered.push(node);
      else foreign.push(node);
    }
    return { covered, foreign };
  }

  function reportForDraft(draft, anchor, pending, context) {
    if (!draft.css) return null;
    const matches = query(context, draft.css);
    if (!matches.includes(anchor)) return null;
    const summary = describeMatches(matches, pending);
    return {
      draft,
      matches,
      covered: summary.covered,
      foreign: summary.foreign,
      foreignCount: summary.foreign.length,
      coveredCount: summary.covered.length
    };
  }

  function betterReport(candidate, current) {
    if (!current) return true;
    if (candidate.foreignCount !== current.foreignCount) {
      return candidate.foreignCount < current.foreignCount;
    }
    if (candidate.coveredCount !== current.coveredCount) {
      return candidate.coveredCount > current.coveredCount;
    }
    if (candidate.draft.rankCost !== current.draft.rankCost) {
      return candidate.draft.rankCost < current.draft.rankCost;
    }
    if (candidate.draft.css.length !== current.draft.css.length) {
      return candidate.draft.css.length < current.draft.css.length;
    }
    return candidate.draft.css.localeCompare(current.draft.css) < 0;
  }

  function includesEvery(container, items) {
    const set = new Set(container);
    return items.every((item) => set.has(item));
  }

  function reversePrune(report, anchor, pending, context) {
    let current = report;
    const removalOrder = [...current.draft.evidence]
      .sort((left, right) => right.rankCost - left.rankCost || right.localLevel - left.localLevel);
    const requiredMatches = current.matches;

    for (const item of removalOrder) {
      const trial = current.draft.remove(item);
      const next = reportForDraft(trial, anchor, pending, context);
      if (!next) continue;
      if (next.foreignCount !== 0) continue;
      if (!includesEvery(next.matches, requiredMatches)) continue;
      current = next;
    }
    return current;
  }

  function synthesizeBranch(anchor, pending, context) {
    const route = new Route(anchor, context.root, context.options);
    const routes = [...pending].map((node) => new Route(node, context.root, context.options));
    const candidates = orderEvidence(route, routes, context.options);
    let report = null;
    let draft = new SelectorDraft(route);

    while (true) {
      let accepted = null;
      for (const item of candidates) {
        checkDeadline(context);
        if (!draft.canAdd(item)) continue;
        const proposal = reportForDraft(draft.add(item), anchor, pending, context);
        if (!proposal) continue;

        const improves = !report
          || proposal.foreignCount < report.foreignCount
          || (proposal.foreignCount === report.foreignCount && proposal.coveredCount > report.coveredCount);
        if (!improves) continue;
        accepted = proposal;
        break;
      }
      if (!accepted) break;
      draft = accepted.draft;
      report = accepted;
      if (report.foreignCount === 0) break;
    }

    if (!report || report.foreignCount !== 0) return null;
    const pruned = reversePrune(report, anchor, pending, context);
    if (context.options.debug) {
      console.debug('[OpenStill SelectorX]', {
        selector: pruned.draft.css,
        covered: pruned.covered.length,
        atoms: pruned.draft.evidence.map((item) => item.asSorterToken())
      });
    }
    return pruned;
  }

  function getCSSSync(elements, rawOptions) {
    const selected = documentOrder(asElements(elements));
    if (!selected.length) return '';
    const options = normalizeOptions(rawOptions);
    const context = createContext(selected, options);

    if (selected.length === 1 && selected[0] === context.documentNode.documentElement && selected[0] === context.root) {
      return ':root';
    }
    if (selected.length === 1 && selected[0] === context.root && isElement(context.root)) {
      return ':scope';
    }

    const pending = new Set(selected);
    const branches = [];
    while (pending.size) {
      checkDeadline(context);
      const anchor = [...pending][0];
      const branch = synthesizeBranch(anchor, pending, context);
      if (!branch || !branch.covered.length) {
        throw new Error('Could not derive a stable CSS selector for the selected element');
      }
      branches.push(branch.draft.css);
      for (const node of branch.covered) pending.delete(node);
      if (branches.length > selected.length) {
        throw new Error('Selector synthesis did not converge');
      }
    }
    return [...new Set(branches)].join(' , ');
  }

  function shadowHostsFor(node, documentNode) {
    const hosts = [];
    let root = node.getRootNode();
    while (root && root !== documentNode) {
      if (!isShadowRoot(root)) break;
      hosts.push(root.host);
      root = root.host.getRootNode();
    }
    return hosts.reverse();
  }

  function getExtendedCSSSync(elements, rawOptions) {
    const selected = asElements(elements);
    if (!selected.length) return '';
    const options = normalizeOptions(rawOptions);
    const lightNodes = [];
    const shadowGroups = new Map();

    for (const node of selected) {
      const root = node.getRootNode();
      if (!isShadowRoot(root)) {
        lightNodes.push(node);
        continue;
      }
      if (!shadowGroups.has(root)) shadowGroups.set(root, []);
      shadowGroups.get(root).push(node);
    }

    const branches = [];
    if (lightNodes.length) {
      const selector = getCSSSync(lightNodes, options);
      if (selector) branches.push(selector);
    }

    for (const [shadowRoot, nodes] of shadowGroups) {
      const documentNode = nodes[0].ownerDocument;
      const hosts = shadowHostsFor(nodes[0], documentNode);
      const hostSelectors = [];
      for (const host of hosts) {
        const hostRoot = host.getRootNode();
        const selector = getCSSSync([host], {
          ...options,
          root: hostRoot === documentNode ? documentNode.documentElement : hostRoot
        });
        if (!selector) {
          hostSelectors.length = 0;
          break;
        }
        hostSelectors.push(selector);
      }
      const terminal = getCSSSync(nodes, { ...options, root: shadowRoot });
      if (terminal) branches.push([...hostSelectors, terminal].join(' '));
    }

    return branches.join(',');
  }

  async function orderEvidenceAsync(route, routes, options) {
    let ordered = orderEvidence(route, routes, { ...options, tokenSorter: undefined });
    if (typeof options.tokenSorter !== 'function') return ordered;
    const supplied = await options.tokenSorter(ordered.map((item) => item.asSorterToken()));
    if (!Array.isArray(supplied)) return ordered;
    const byId = new Map(ordered.map((item) => [item.id, item]));
    const reordered = supplied
      .map((token) => byId.get(typeof token === 'string' ? token : token?.id))
      .filter(Boolean);
    return [...reordered, ...ordered.filter((item) => !reordered.includes(item))];
  }

  async function synthesizeBranchAsync(anchor, pending, context) {
    const route = new Route(anchor, context.root, context.options);
    const routes = [...pending].map((node) => new Route(node, context.root, context.options));
    const candidates = await orderEvidenceAsync(route, routes, context.options);
    let report = null;
    let draft = new SelectorDraft(route);
    while (true) {
      let accepted = null;
      for (const item of candidates) {
        checkDeadline(context);
        if (!draft.canAdd(item)) continue;
        const proposal = reportForDraft(draft.add(item), anchor, pending, context);
        if (!proposal) continue;
        const improves = !report
          || proposal.foreignCount < report.foreignCount
          || (proposal.foreignCount === report.foreignCount && proposal.coveredCount > report.coveredCount);
        if (!improves) continue;
        accepted = proposal;
        break;
      }
      if (!accepted) break;
      draft = accepted.draft;
      report = accepted;
      if (report.foreignCount === 0) break;
    }
    if (!report || report.foreignCount !== 0) return null;
    return reversePrune(report, anchor, pending, context);
  }

  async function getCSSAsync(elements, rawOptions) {
    const selected = documentOrder(asElements(elements));
    if (!selected.length) return '';
    const options = normalizeOptions(rawOptions);
    const context = createContext(selected, options);
    if (selected.length === 1 && selected[0] === context.documentNode.documentElement && selected[0] === context.root) {
      return ':root';
    }
    if (selected.length === 1 && selected[0] === context.root && isElement(context.root)) return ':scope';
    const pending = new Set(selected);
    const branches = [];
    while (pending.size) {
      checkDeadline(context);
      const anchor = [...pending][0];
      const branch = await synthesizeBranchAsync(anchor, pending, context);
      if (!branch?.covered.length) throw new Error('Could not derive a stable CSS selector for the selected element');
      branches.push(branch.draft.css);
      branch.covered.forEach((node) => pending.delete(node));
      if (branches.length > selected.length) throw new Error('Selector synthesis did not converge');
    }
    return [...new Set(branches)].join(' , ');
  }

  async function getExtendedCSSAsync(elements, rawOptions) {
    const selected = asElements(elements);
    if (!selected.length) return '';
    const options = normalizeOptions(rawOptions);
    const lightNodes = [];
    const shadowGroups = new Map();
    for (const node of selected) {
      const root = node.getRootNode();
      if (!isShadowRoot(root)) lightNodes.push(node);
      else {
        if (!shadowGroups.has(root)) shadowGroups.set(root, []);
        shadowGroups.get(root).push(node);
      }
    }
    const branches = [];
    if (lightNodes.length) {
      const selector = await getCSSAsync(lightNodes, options);
      if (selector) branches.push(selector);
    }
    for (const [shadowRoot, nodes] of shadowGroups) {
      const documentNode = nodes[0].ownerDocument;
      const hosts = shadowHostsFor(nodes[0], documentNode);
      const hostSelectors = [];
      for (const host of hosts) {
        const hostRoot = host.getRootNode();
        const selector = await getCSSAsync([host], {
          ...options,
          root: hostRoot === documentNode ? documentNode.documentElement : hostRoot
        });
        if (!selector) {
          hostSelectors.length = 0;
          break;
        }
        hostSelectors.push(selector);
      }
      const terminal = await getCSSAsync(nodes, { ...options, root: shadowRoot });
      if (terminal) branches.push([...hostSelectors, terminal].join(' '));
    }
    return branches.join(',');
  }

  // Keep the synchronous picker path fast, while honoring the reference
  // asynchronous extension point whenever a caller supplies a token sorter.
  function configuredRoot(rawOptions) {
    if (isElement(rawOptions) || isDocument(rawOptions) || isShadowRoot(rawOptions)) return rawOptions;
    return rawOptions && typeof rawOptions === 'object' ? rawOptions.root || null : null;
  }

  function scopeCssForConfiguredRoot(selector, rawOptions) {
    const root = configuredRoot(rawOptions);
    if (!selector || !isElement(root) || root === root.ownerDocument?.documentElement) return selector;
    return splitSelectorUnion(selector).map((branch) => {
      const trimmed = branch.trim();
      return trimmed === ':scope' || trimmed.startsWith(':scope ') ? trimmed : ':scope ' + trimmed;
    }).join(' , ');
  }

  // SelectorX is an asynchronous contract even when no plugin needs to await.
  // Keeping that boundary stable prevents callers from racing a future token
  // sorter or a yielding DOM implementation. The synchronous variants remain
  // available for the pointer-hover picker path, where a Promise cannot be
  // rendered directly into an input or a tooltip.
  function getCSS(elements, rawOptions) {
    if (typeof rawOptions?.tokenSorter === 'function') {
      return getCSSAsync(elements, rawOptions).then((selector) => scopeCssForConfiguredRoot(selector, rawOptions));
    }
    return Promise.resolve(scopeCssForConfiguredRoot(getCSSSync(elements, rawOptions), rawOptions));
  }

  function getExtendedCSS(elements, rawOptions) {
    if (typeof rawOptions?.tokenSorter === 'function') {
      return getExtendedCSSAsync(elements, rawOptions);
    }
    return Promise.resolve(getExtendedCSSSync(elements, rawOptions));
  }

  // Extended CSS is a small, explicit traversal language used by the picker
  // and the capture worker.  Its written form intentionally remains CSS-like:
  // a whitespace boundary may cross from a host into one of its shadow roots.
  // Keeping parsing and traversal here (rather than teaching every caller a
  // special case) also makes ordinary CSS a strict subset of the same API.
  function shadowRootFor(element) {
    if (!isElement(element)) return null;
    try {
      return element.shadowRoot
        || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)
        || null;
    } catch {
      return element.shadowRoot || null;
    }
  }

  function splitSelectorUnion(value) {
    const source = String(value || '');
    const result = [];
    let buffer = '';
    let quote = '';
    let escaped = false;
    let brackets = 0;
    let parentheses = 0;

    for (const character of source) {
      if (escaped) {
        buffer += character;
        escaped = false;
        continue;
      }
      if (character === '\\') {
        buffer += character;
        escaped = true;
        continue;
      }
      if (quote) {
        buffer += character;
        if (character === quote) quote = '';
        continue;
      }
      if (character === "'" || character === '"') {
        buffer += character;
        quote = character;
        continue;
      }
      if (character === '[') brackets += 1;
      if (character === ']') brackets = Math.max(0, brackets - 1);
      if (character === '(') parentheses += 1;
      if (character === ')') parentheses = Math.max(0, parentheses - 1);
      if (character === ',' && !brackets && !parentheses) {
        if (buffer.trim()) result.push(buffer.trim());
        buffer = '';
        continue;
      }
      buffer += character;
    }
    if (buffer.trim()) result.push(buffer.trim());
    return result;
  }

  function splitExtendedSteps(value) {
    const source = String(value || '').trim();
    if (!source) return [];
    const parts = [];
    let buffer = '';
    let quote = '';
    let escaped = false;
    let escapedHexDigits = 0;
    let brackets = 0;
    let parentheses = 0;
    const flush = () => {
      if (buffer.trim()) parts.push(buffer.trim());
      buffer = '';
    };

    for (const character of source) {
      if (escaped) {
        buffer += character;
        escaped = false;
        escapedHexDigits = /[0-9a-f]/i.test(character) ? 1 : 0;
        continue;
      }
      if (escapedHexDigits) {
        if (/[0-9a-f]/i.test(character) && escapedHexDigits < 6) {
          buffer += character;
          escapedHexDigits += 1;
          continue;
        }
        // A single whitespace terminates a CSS hexadecimal escape and is part
        // of the selector token, not an XCSS shadow-piercing step boundary.
        if (/\s/.test(character)) {
          buffer += character;
          escapedHexDigits = 0;
          continue;
        }
        escapedHexDigits = 0;
      }
      if (character === '\\') {
        buffer += character;
        escaped = true;
        continue;
      }
      if (quote) {
        buffer += character;
        if (character === quote) quote = '';
        continue;
      }
      if (character === "'" || character === '"') {
        buffer += character;
        quote = character;
        continue;
      }
      if (character === '[') brackets += 1;
      if (character === ']') brackets = Math.max(0, brackets - 1);
      if (character === '(') parentheses += 1;
      if (character === ')') parentheses = Math.max(0, parentheses - 1);
      if (/\s/.test(character) && !brackets && !parentheses) {
        flush();
        continue;
      }
      buffer += character;
    }
    flush();

    // Native combinators remain a single query step. A plain whitespace is
    // deliberately left as a step boundary, which is what lets it pierce an
    // intervening shadow root.
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (/^[>+~]$/.test(part) && index > 0 && index < parts.length - 1) {
        parts[index - 1] += part + parts[index + 1];
        parts.splice(index, 2);
        index -= 1;
      } else if (/[>+~]$/.test(part) && index < parts.length - 1) {
        parts[index] += parts[index + 1];
        parts.splice(index + 1, 1);
        index -= 1;
      } else if (/^[>+~]/.test(part) && index > 0) {
        parts[index - 1] += part;
        parts.splice(index, 1);
        index -= 1;
      }
    }
    return parts.filter(Boolean);
  }

  function uniqueInDiscoveryOrder(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function descendantsAndShadowMatches(selector, root) {
    const result = [];
    const visitedRoots = new Set();
    const visit = (scope) => {
      if (!scope || visitedRoots.has(scope) || typeof scope.querySelectorAll !== 'function') return;
      visitedRoots.add(scope);
      let matches = [];
      let descendants = [];
      try {
        matches = [...scope.querySelectorAll(selector)];
        descendants = [...scope.querySelectorAll('*')];
      } catch {
        // An invalid selector should have the same observable behaviour as
        // native querySelectorAll: no partial result is returned to callers.
        throw new Error('Invalid extended CSS selector: ' + selector);
      }
      result.push(...matches);
      const shadowCandidates = isElement(scope) ? [scope, ...descendants] : descendants;
      for (const element of shadowCandidates) {
        const shadow = shadowRootFor(element);
        if (shadow) visit(shadow);
      }
    };
    visit(root);
    return uniqueInDiscoveryOrder(result);
  }

  function queryExtendedCSS(selector, root = globalThis.document) {
    const scope = root || globalThis.document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return [];
    const result = [];
    for (const branch of splitSelectorUnion(selector)) {
      let roots = [scope];
      for (const step of splitExtendedSteps(branch)) {
        const next = [];
        for (const currentRoot of roots) {
          next.push(...descendantsAndShadowMatches(step, currentRoot));
        }
        roots = uniqueInDiscoveryOrder(next);
        if (!roots.length) break;
      }
      result.push(...roots);
    }
    return uniqueInDiscoveryOrder(result);
  }

  function xpathLiteral(value) {
    const text = String(value ?? '');
    if (!text.includes("'")) return "'" + text + "'";
    if (!text.includes('"')) return '"' + text + '"';
    const pieces = text.split("'");
    return 'concat(' + pieces.map((piece, index) => (
      (index ? '"\'",' : '') + "'" + piece + "'"
    )).join(',') + ')';
  }

  function evaluateXPath(value, root = globalThis.document) {
    const scope = root || globalThis.document;
    const documentNode = isDocument(scope) ? scope : scope?.ownerDocument;
    if (!documentNode || typeof documentNode.evaluate !== 'function') return [];
    const iteratorType = globalThis.XPathResult?.ORDERED_NODE_ITERATOR_TYPE ?? 5;
    let result;
    try {
      result = documentNode.evaluate(
        String(value || ''),
        scope,
        (prefix) => prefix === 'xhtml' ? 'http://www.w3.org/1999/xhtml' : null,
        iteratorType,
        null
      );
    } catch (error) {
      throw new Error('Invalid XPath selector: ' + error.message);
    }
    const nodes = [];
    try {
      for (let node = result.iterateNext(); node; node = result.iterateNext()) nodes.push(node);
    } catch (error) {
      throw new Error('Document changed while evaluating XPath: ' + error.message);
    }
    return nodes;
  }

  function xpathNodePosition(node) {
    const parent = node.parentElement;
    if (!parent) return 1;
    const sameName = [...parent.children].filter((sibling) => sibling.localName === node.localName);
    return Math.max(1, sameName.indexOf(node) + 1);
  }

  function xpathAttributeFor(node, root) {
    const choices = [];
    const id = node.getAttribute?.('id');
    if (id && isStableValue(id)) choices.push(['id', id]);
    for (const attribute of [...(node.attributes || [])]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name === 'id' || name === 'class' || !isSafeAttributeName(name) || !isStableValue(value)) continue;
      if (name.startsWith('data-') || SEMANTIC_ATTRIBUTE_NAMES.has(name)) choices.push([name, value]);
    }
    for (const [name, value] of choices) {
      const candidate = "//*[@" + name + '=' + xpathLiteral(value) + ']';
      try {
        const matches = evaluateXPath(candidate, root);
        if (matches.length === 1 && matches[0] === node) return candidate;
      } catch {
        // Continue with an unambiguous structural segment.
      }
    }
    return '';
  }

  function xpathForElement(target, root, options) {
    const documentNode = target.ownerDocument;
    const queryRoot = root || documentNode;
    if (isShadowRoot(target.getRootNode())) {
      throw new Error('XPath cannot cross a shadow-root boundary; use extended CSS instead');
    }
    const chain = [];
    for (let current = target; isElement(current); current = current.parentElement) {
      chain.push(current);
      if (current === queryRoot || current === documentNode.documentElement) break;
    }
    const text = cleanXPathText(target.textContent);
    if (options.useText && text && isStableValue(text) && text.length <= 80) {
      const byText = '//*[normalize-space(.)=' + xpathLiteral(text) + ']';
      try {
        const matches = evaluateXPath(byText, queryRoot);
        if (matches.length === 1 && matches[0] === target) return byText;
      } catch {
        // A stable element route is a safer fallback.
      }
    }

    for (let index = 0; index < chain.length; index += 1) {
      const anchor = xpathAttributeFor(chain[index], queryRoot);
      if (!anchor) continue;
      const descendants = chain.slice(0, index).reverse();
      return anchor + descendants.map((node) => (
        '/' + node.localName.toLowerCase() + '[' + xpathNodePosition(node) + ']'
      )).join('');
    }

    return '//' + chain.slice().reverse().map((node) => (
      node.localName.toLowerCase() + '[' + xpathNodePosition(node) + ']'
    )).join('/');
  }

  function cleanXPathText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getXPATHSync(elements, rawOptions) {
    const selected = documentOrder(asElements(elements));
    if (!selected.length) return '';
    const options = normalizeOptions(rawOptions);
    const documentNode = selected[0].ownerDocument;
    for (const element of selected) {
      if (element.ownerDocument !== documentNode) {
        throw new Error('elements do not belong to the same document');
      }
    }
    const root = options.root || documentNode;
    const paths = selected.map((element) => xpathForElement(element, root, options));
    const selector = [...new Set(paths)].join(' | ');
    const configured = configuredRoot(rawOptions);
    if (!selector || !isElement(configured) || configured === configured.ownerDocument?.documentElement) return selector;
    return selector.split(/\s+\|\s+/).map((path) => (
      path.startsWith('.') ? path : '.' + path
    )).join(' | ');
  }

  function getXPATH(elements, rawOptions) {
    return Promise.resolve(getXPATHSync(elements, rawOptions));
  }

  class SelectorExpression {
    constructor(value, type = 'css') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.value = String(value.value ?? value.expr ?? '');
        this.type = String(value.type ?? type).toLowerCase();
        this.meta = value.meta ?? null;
      } else {
        this.value = String(value ?? '');
        this.type = type;
        this.meta = null;
      }
    }

    select() {
      return Promise.resolve([]);
    }

    async count(root) {
      return (await this.select(root)).length;
    }

    getType() {
      return this.type;
    }

    toJSON() {
      return { type: this.type, meta: this.meta, value: this.value };
    }
  }

  class CSSSelector extends SelectorExpression {
    constructor(value) {
      super(value, 'css');
      this.type = 'css';
    }

    select(root = globalThis.document) {
      if (!root || typeof root.querySelectorAll !== 'function') return Promise.resolve([]);
      try {
        return Promise.resolve([...root.querySelectorAll(this.value)]);
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }

  class ExtendedCSSSelector extends SelectorExpression {
    constructor(value) {
      super(value, 'xcss');
      this.type = 'xcss';
    }

    select(root = globalThis.document) {
      try {
        return Promise.resolve(queryExtendedCSS(this.value, root));
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }

  class XPathSelector extends SelectorExpression {
    constructor(value) {
      super(value, 'xpath');
      this.type = 'xpath';
    }

    select(root = globalThis.document) {
      try {
        return Promise.resolve(evaluateXPath(this.value, root));
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }

  function selectorBuilder(value, root = globalThis.document) {
    const selector = value instanceof SelectorExpression
      ? value
      : value && typeof value === 'object'
        ? value
        : { type: 'css', value };
    const type = String(selector.type || 'css').toLowerCase();
    if (type === 'xpath') return new XPathSelector(selector);
    if (type === 'xcss' || type === 'extended-css' || type === 'extendedcss') {
      return new ExtendedCSSSelector(selector);
    }
    if (type === 'css') return new CSSSelector(selector);
    throw new Error('Unsupported selector type: ' + type + (root ? '' : ''));
  }

  function select(value, doc = globalThis.document, rootNode = globalThis.document) {
    return selectorBuilder(value, rootNode).select(doc);
  }

  function interactiveRoot(nodes, configuredRoot) {
    if (configuredRoot) return configuredRoot;
    if (!nodes.length) return null;
    let root = nodes[0].ownerDocument.documentElement;
    for (const candidate of [...root.children]) {
      if (nodes.every((node) => candidate.contains(node)) && !nodes.includes(candidate)) {
        root = candidate;
      }
    }
    return root;
  }

  function exactScopedPath(element, root) {
    const segments = [];
    for (let current = element; isElement(current) && current !== root; current = current.parentElement) {
      const tag = String(current.localName || '*').toLowerCase();
      const position = childPosition(current);
      const pseudo = position.index > 0 ? ':nth-child(' + position.index + ')' : '';
      segments.unshift(tag + pseudo);
    }
    if (!segments.length) return ':scope';
    return ':scope > ' + segments.join(' > ');
  }

  class SelectorX {
    static ADDED_SELECTION = 1;
    static REMOVED_SELECTION = 2;
    static ADDED_REJECTION = 3;
    static REMOVED_REJECTION = 4;
    static NO_ACTION = 0;

    constructor(options = {}) {
      this.options = options && typeof options === 'object' ? options : {};
      this._selected = new Set();
      this._rejected = new Set();
      this._similar = new Set();
      this._selector = '';
      this._latestAction = SelectorX.NO_ACTION;
    }

    get selected() { return [...this._selected]; }
    get rejected() { return [...this._rejected]; }
    get similar() { return [...this._similar]; }
    get selector() { return this._selector; }
    isSelection(element) { return this._selected.has(element); }
    isRejection(element) { return this._rejected.has(element); }
    isSimilar(element) { return this._similar.has(element); }

    reset() {
      this._selected.clear();
      this._rejected.clear();
      this._similar.clear();
      this._selector = '';
      this._latestAction = SelectorX.NO_ACTION;
    }

    _assertCompatible(element) {
      if (!isElement(element)) throw new Error('selection must be an element');
      const existing = this.selected[0] || this.rejected[0];
      if (existing && existing.ownerDocument !== element.ownerDocument) {
        throw new Error('element not part of document');
      }
    }

    _commonCandidates(root) {
      const desired = this.selected;
      if (!desired.length) return [];
      const context = createContext(desired, {
        ...normalizeOptions(this.options),
        root
      });
      const routes = desired.map((node) => new Route(node, root, context.options));
      const candidateByCss = new Map();
      for (const route of routes) {
        decorateEvidence(route, routes);
        for (const evidence of route.evidence) {
          if (evidence.bridge || evidence.offset !== 0 || evidence.localLevel !== 0) continue;
          const existing = candidateByCss.get(evidence.css);
          if (!existing || evidence.rankCost < existing.rankCost) candidateByCss.set(evidence.css, evidence);
        }
      }
      return [...candidateByCss.values()].sort((left, right) => left.rankCost - right.rankCost || left.css.localeCompare(right.css));
    }

    async update() {
      const selected = this.selected;
      if (!selected.length) throw new Error('empty list of selected');
      const root = interactiveRoot(selected, this.options.root);
      const rejected = new Set(this.rejected);
      let best = null;
      let candidates = [];
      try {
        candidates = this._commonCandidates(root);
      } catch {
        candidates = [];
      }
      for (const candidate of candidates) {
        let matches;
        try {
          matches = [...root.querySelectorAll(candidate.css)];
        } catch {
          continue;
        }
        if (!selected.every((node) => matches.includes(node))) continue;
        if (matches.some((node) => rejected.has(node))) continue;
        const score = candidate.rankCost - Math.min(10, matches.length) * 0.08;
        if (!best || score < best.score || (score === best.score && candidate.css.length < best.css.length)) {
          best = { css: candidate.css, matches, score };
        }
      }
      if (!best) {
        let css;
        try {
          css = await getCSS(selected, { ...this.options, root });
        } catch {
          css = selected.map((node) => exactScopedPath(node, root)).join(' , ');
        }
        best = { css, matches: [...root.querySelectorAll(css)], score: Number.POSITIVE_INFINITY };
      }
      this._selector = best.css;
      this._similar = new Set(best.matches.filter((node) => !this._selected.has(node)));
      return this._selector;
    }

    async addSelection(element) {
      this._assertCompatible(element);
      this._rejected.delete(element);
      if (!this._selected.has(element)) {
        this._selected.add(element);
        this._latestAction = SelectorX.ADDED_SELECTION;
      }
      return this.update();
    }

    async addRejection(element) {
      this._assertCompatible(element);
      this._selected.delete(element);
      if (!this._rejected.has(element)) {
        this._rejected.add(element);
        this._latestAction = SelectorX.ADDED_REJECTION;
      }
      return this.update();
    }

    async removeSelection(element) {
      if (this._selected.delete(element)) this._latestAction = SelectorX.REMOVED_SELECTION;
      return this.update();
    }

    async removeRejection(element) {
      if (this._rejected.delete(element)) this._latestAction = SelectorX.REMOVED_REJECTION;
      return this.update();
    }

    async set(elements) {
      const desired = asElements(elements);
      if (!desired.length) throw new Error('empty list of selected');
      this.reset();
      for (const element of desired) this._selected.add(element);
      this._latestAction = SelectorX.ADDED_SELECTION;
      // A set operation is expected to converge on exactly the supplied set,
      // so use the full synthesizer once and retain any other candidates as
      // explicit rejections for subsequent interactive edits.
      const root = interactiveRoot(desired, this.options.root);
      try {
        this._selector = await getCSS(desired, { ...this.options, root });
      } catch {
        this._selector = desired.map((node) => exactScopedPath(node, root)).join(' , ');
      }
      const matches = [...root.querySelectorAll(this._selector)];
      for (const node of matches) {
        if (!this._selected.has(node)) this._rejected.add(node);
      }
      this._similar.clear();
      return this._selector;
    }
  }

  globalThis.__openStillSelectorX = Object.freeze({
    getCSS,
    getCSSSync,
    getExtendedCSS,
    getExtendedCSSSync,
    getXPATH,
    getXPATHSync,
    getXpath: getXPATH,
    getXCSS: getExtendedCSS,
    querySelectorAll: queryExtendedCSS,
    queryExtendedCSS,
    evaluateXPath,
    selectorBuilder,
    select,
    CSSSelector,
    ExtendedCSSSelector,
    XPathSelector,
    SelectorX
  });
})();
