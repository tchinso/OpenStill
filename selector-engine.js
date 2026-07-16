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
  const MAX_NEUTRAL_EVIDENCE = 10;
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
    // Token metadata distinguishes an absent value from an empty attribute.
    // Preserve that boundary for extension callbacks: tags, relation bridges,
    // and attribute-presence tests carry no value in the SelectorX contract.
    const callbackName = type === 'immediate' ? null : name;
    const callbackValue = ['tag', 'immediate', 'attribOnly'].includes(type) ? null : value;
    return Boolean(options.filterCallback(type, callbackName, callbackValue, depth, offset));
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

  function readableTextTokens(node) {
    const values = [];
    const visited = new Set();
    const visit = (current) => {
      if (!current || visited.has(current) || values.length >= 15) return;
      visited.add(current);
      if (current.nodeType === Node.TEXT_NODE) {
        const text = cleanXPathText(current.nodeValue);
        if (!text || text.includes("'") || text.length > 180 || hasGeneratedShape(text)) return;
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length <= 3) {
          values.push(text);
        } else if (words.length <= 5) {
          for (const word of words) {
            if (word.length > 3 && !hasGeneratedShape(word)) values.push(word);
          }
        }
        return;
      }
      if (current.nodeType !== Node.ELEMENT_NODE) return;
      for (const child of current.childNodes) visit(child);
    };
    visit(node);
    return [...new Set(values)].slice(0, 15);
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
        xpathOnly: Boolean(this.xpathOnly),
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
        xpathOnly: Boolean(details.xpathOnly),
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

      // XPath can express stable rendered text directly, while CSS cannot.
      // Surface it to XPath callbacks and token sorters without allowing an
      // empty CSS atom to enter the CSS draft.
      if (this.options.useText) {
        for (const text of readableTextTokens(node)) {
          this._add('text', 'text', text, '', step, offset, {
            ...nodeDetails,
            semantic: true,
            xpathOnly: true
          });
        }
      }

      const position = childPosition(node);
      if (position.index > 0 && position.count > 1) {
        const pseudo = position.index === 1
          ? ':first-child'
          : ':nth-child(' + position.index + ')';
        // Keep a positional atom self-contained so it can stand on its own.
        // SelectorDraft._compound() folds its tag with sibling class/tag atoms
        // instead of concatenating a second tag into the compound selector.
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
        if (!className) continue;
        if (isStableValue(className, { allowShort: true })) {
          const simple = /^[a-zA-Z_][\w-]*$/.test(className);
          const css = simple
            ? '.' + escapeIdentifier(className)
            : "[class*='" + escapeString(className) + "']";
          this._add('attrib', 'class', className, css, step, offset, {
            ...nodeDetails,
            semantic: true,
            specialClass: !simple
          });
        }

        if (this.options.partAttrib && className.length <= 2_000 && !hasGeneratedShape(className)) {
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
        if (!value) continue;
        if (isStableValue(value, { allowShort: true })) {
          this._add('attrib', name, value, '[' + escapedName + "='" + escapeString(value) + "']", step, offset, {
            ...nodeDetails,
            semantic: name.startsWith('data-') || SEMANTIC_ATTRIBUTE_NAMES.has(name)
          });
        }

        // Long values such as descriptive data attributes are poor exact
        // selectors, but their readable word fragments can still be the most
        // stable evidence. Extract those independently of the exact-value
        // length limit while bounding work on pathological payloads.
        if (!this.options.partAttrib || value.length > 2_000 || hasGeneratedShape(value)) continue;
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
      if (item.xpathOnly) return false;
      if (this.evidenceIds.has(item.id)) return false;
      if (!this.evidence.length) {
        // A stable ancestor or preceding sibling can be the only usable
        // semantic evidence. The serializer appends an implicit descendant
        // wildcard when a target-level atom is unavailable, rather than
        // forcing an unstable nth-child path just to start at the leaf.
        return !item.bridge;
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
      const sorted = [...items]
        .sort((left, right) => (
          (order[left.type] ?? 9) - (order[right.type] ?? 9)
          || left.css.localeCompare(right.css)
        ));
      const tag = sorted.find((item) => item.type === 'tag');
      const positions = sorted.filter((item) => item.type === 'pos');
      const positionTag = positions[0]?.name ? escapeIdentifier(positions[0].name) : '';
      const baseTag = tag?.css || positionTag;
      const attributes = sorted
        .filter((item) => item.type !== 'tag' && item.type !== 'pos')
        .map((item) => item.css);
      const pseudos = positions.map((item) => {
        const prefix = item.name ? escapeIdentifier(item.name) : '';
        return prefix && item.css.startsWith(prefix) ? item.css.slice(prefix.length) : item.css;
      });
      return [baseTag, ...attributes, ...pseudos].join('');
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
        if (priorOffset !== null && !laneOffsets.includes(0)) {
          row += this.route.isImmediateSiblingStep(localLevel, priorOffset, 0) ? ' + *' : ' ~ *';
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
      // Evidence may stop at an ancestor/sibling lane. Preserve the route's
      // target reachability with a descendant wildcard, the CSS analogue of a
      // relative selector tail. It is added only when no leaf lane was chosen
      // so ordinary compact selectors remain unchanged.
      if (levels.length && Math.min(...levels) > 0) {
        parts.push(' *');
      }
      return parts.join('');
    }
  }

  function rootContains(root, element) {
    if (root === element) return true;
    if (isDocument(root)) return Boolean(root.documentElement && root.documentElement.contains(element));
    return typeof root?.contains === 'function' && root.contains(element);
  }

  // An extended CSS root is a composed-tree boundary, not merely a light-DOM
  // one.  `Element.contains()` deliberately stops at a shadow boundary, which
  // made a closed-shadow target look outside an otherwise valid host/root.
  // Walk through shadow hosts explicitly so XCSS can validate the same reach
  // that its executor provides, while still rejecting disconnected and
  // unrelated nodes.
  function composedParent(element) {
    if (!isElement(element)) return null;
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return isShadowRoot(root) ? root.host : null;
  }

  function xcssRootContains(root, element) {
    if (!root || !isElement(element)) return false;
    const rootDocument = isDocument(root) ? root : root.ownerDocument;
    if (!rootDocument || element.ownerDocument !== rootDocument) return false;

    const visited = new Set();
    let current = element;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current === root || current.getRootNode?.() === root) return true;
      current = composedParent(current);
    }
    return false;
  }

  function validateExtendedContext(selected, options) {
    const documentNode = selected[0].ownerDocument;
    const root = options.root || documentNode.documentElement;
    const rootDocument = isDocument(root) ? root : root?.ownerDocument;
    if (rootDocument !== documentNode) {
      throw new Error('root node does not belong to the same document');
    }
    if (!root || typeof root.querySelectorAll !== 'function') {
      throw new Error('root node does not support selector queries');
    }
    for (const element of selected) {
      if (element.ownerDocument !== documentNode) {
        throw new Error('elements do not belong to the same document');
      }
      if (!xcssRootContains(root, element)) {
        throw new Error('target is not in subtree of root');
      }
    }
    return { documentNode, root };
  }

  function nativeRootContains(root, element) {
    if (root === element) return true;
    if (isDocument(root)) return Boolean(root.documentElement?.contains(element));
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
      immediate: input.immediate !== false,
      useText: input.useText === true
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
        ordered = supplied
          .map((token) => byId.get(typeof token === 'string' ? token : token?.id))
          .filter((item, index, values) => item && values.indexOf(item) === index);
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

  function canAccumulateNeutralEvidence(item) {
    return item.type === 'pos'
      || (item.semantic && ['attrib', 'attribStart', 'attribEnd', 'attribContain'].includes(item.type));
  }

  function synthesizeBranch(anchor, pending, context) {
    const route = new Route(anchor, context.root, context.options);
    const routes = [...pending].map((node) => new Route(node, context.root, context.options));
    const candidates = orderEvidence(route, routes, context.options);
    let report = null;
    let draft = new SelectorDraft(route);
    let neutralEvidence = 0;

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
        const preservesCoverage = report
          && proposal.foreignCount === report.foreignCount
          && proposal.coveredCount === report.coveredCount
          // A neutral atom is only safe when it preserves the exact candidate
          // set. Equal counts alone could swap one foreign match for another.
          && includesEvery(proposal.matches, report.matches)
          && neutralEvidence < MAX_NEUTRAL_EVIDENCE
          && canAccumulateNeutralEvidence(item);
        if (!improves && !preservesCoverage) continue;
        accepted = { report: proposal, neutral: !improves };
        break;
      }
      if (!accepted) break;
      draft = accepted.report.draft;
      report = accepted.report;
      neutralEvidence = accepted.neutral ? neutralEvidence + 1 : 0;
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
    const { documentNode: selectedDocument, root: configuredRoot } = validateExtendedContext(selected, options);
    const scopedOptions = { ...options, root: configuredRoot };
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
      const selector = getCSSSync(lightNodes, scopedOptions);
      if (selector) branches.push(selector);
    }

    for (const [shadowRoot, nodes] of shadowGroups) {
      const hosts = shadowHostsFor(nodes[0], selectedDocument)
        // A configured host/root is already the starting point of an XCSS
        // query. Repeating it would ask querySelectorAll() to find itself,
        // while hosts above a shadow-root scope are unreachable from that
        // scope and must not leak into the generated route.
        .filter((host) => host !== configuredRoot && xcssRootContains(configuredRoot, host));
      const hostSelectors = [];
      for (let index = 0; index < hosts.length; index += 1) {
        const host = hosts[index];
        const hostRoot = host.getRootNode();
        const hostScope = index === 0 && nativeRootContains(configuredRoot, host)
          ? configuredRoot
          : hostRoot === selectedDocument ? selectedDocument.documentElement : hostRoot;
        const selector = getCSSSync([host], {
          ...scopedOptions,
          root: hostScope
        });
        if (!selector) {
          hostSelectors.length = 0;
          break;
        }
        hostSelectors.push(selector);
      }
      const terminal = getCSSSync(nodes, { ...scopedOptions, root: shadowRoot });
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
    return supplied
      .map((token) => byId.get(typeof token === 'string' ? token : token?.id))
      .filter((item, index, values) => item && values.indexOf(item) === index);
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
    const { documentNode: selectedDocument, root: configuredRoot } = validateExtendedContext(selected, options);
    const scopedOptions = { ...options, root: configuredRoot };
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
      const selector = await getCSSAsync(lightNodes, scopedOptions);
      if (selector) branches.push(selector);
    }
    for (const [shadowRoot, nodes] of shadowGroups) {
      const hosts = shadowHostsFor(nodes[0], selectedDocument)
        .filter((host) => host !== configuredRoot && xcssRootContains(configuredRoot, host));
      const hostSelectors = [];
      for (let index = 0; index < hosts.length; index += 1) {
        const host = hosts[index];
        const hostRoot = host.getRootNode();
        const hostScope = index === 0 && nativeRootContains(configuredRoot, host)
          ? configuredRoot
          : hostRoot === selectedDocument ? selectedDocument.documentElement : hostRoot;
        const selector = await getCSSAsync([host], {
          ...scopedOptions,
          root: hostScope
        });
        if (!selector) {
          hostSelectors.length = 0;
          break;
        }
        hostSelectors.push(selector);
      }
      const terminal = await getCSSAsync(nodes, { ...scopedOptions, root: shadowRoot });
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
    return Promise.resolve().then(() => scopeCssForConfiguredRoot(getCSSSync(elements, rawOptions), rawOptions));
  }

  function getExtendedCSS(elements, rawOptions) {
    if (typeof rawOptions?.tokenSorter === 'function') {
      return getExtendedCSSAsync(elements, rawOptions);
    }
    return Promise.resolve().then(() => getExtendedCSSSync(elements, rawOptions));
  }

  // Extended CSS is a small, explicit traversal language used by the picker
  // and the capture worker.  Its written form intentionally remains CSS-like:
  // a whitespace boundary may cross from a host into one of its shadow roots.
  // Keeping parsing and traversal here (rather than teaching every caller a
  // special case) also makes ordinary CSS a strict subset of the same API.
  function isInternalPickerHost(element) {
    return isElement(element)
      && String(element.localName || '').toLowerCase() === 'openstill-picker-root'
      && element.getAttribute?.('data-openstill-picker-ui') === 'true';
  }

  function isInsideInternalPicker(element) {
    let current = isElement(element) ? element : null;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (isInternalPickerHost(current)) return true;
      current = composedParent(current);
    }
    return false;
  }

  function shadowRootFor(element) {
    if (!isElement(element)) return null;
    // The picker itself is a closed shadow tree. It is extension UI rather
    // than page content, so letting XCSS pierce it would make broad selectors
    // such as `button` or `input` match the picker controls while editing.
    if (isInternalPickerHost(element)) return null;
    // A page can expose a compatibility `_shadowRoot` getter which throws.
    // Treat only that host as opaque rather than failing an entire XCSS query.
    const read = (getter) => {
      try { return getter() || null; } catch { return null; }
    };
    const usable = (root) => root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE
      && typeof root.querySelectorAll === 'function'
      ? root
      : null;
    return usable(read(() => element.shadowRoot))
      || usable(read(() => element._shadowRoot))
      || usable(read(() => globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)));
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
        matches = [...scope.querySelectorAll(selector)].filter((element) => !isInsideInternalPicker(element));
        descendants = [...scope.querySelectorAll('*')].filter((element) => !isInsideInternalPicker(element));
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
    // The Reference locator uses a Document's first element (<html>) as the
    // XPath context. Preserve an explicitly supplied Element/ShadowRoot as-is
    // so scoped selector APIs keep their documented relative-root contract.
    const contextNode = isDocument(scope) ? scope.documentElement || scope : scope;
    const iteratorType = globalThis.XPathResult?.ORDERED_NODE_ITERATOR_TYPE ?? 5;
    let result;
    try {
      result = documentNode.evaluate(
        String(value || ''),
        contextNode,
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
        '/' + xpathNameFor(node) + '[' + xpathNodePosition(node) + ']'
      )).join('');
    }

    return '//' + chain.slice().reverse().map((node) => (
      xpathNameFor(node) + '[' + xpathNodePosition(node) + ']'
    )).join('/');
  }

  function cleanXPathText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function xpathNameFor(node) {
    const rawName = String(node?.localName || '');
    const namespace = String(node?.namespaceURI || '');
    const isHtmlDocument = String(node?.ownerDocument?.contentType || '').toLowerCase() === 'text/html';
    const isHtmlElement = namespace === 'http://www.w3.org/1999/xhtml' && isHtmlDocument;
    const name = isHtmlElement ? rawName.toLowerCase() : rawName;
    if (!name) return '*';

    // Unprefixed XPath names work for ordinary HTML elements in an HTML
    // document, but not for SVG, MathML, custom XML namespaces, or XHTML/XML
    // documents.  A local-name/namespace pair keeps those expressions valid
    // without requiring callers to know or register a prefix.
    if (namespace && !isHtmlElement) {
      return "*[local-name()=" + xpathLiteral(name)
        + ' and namespace-uri()=' + xpathLiteral(namespace) + ']';
    }

    return /^[a-z_][a-z\d_-]*$/i.test(name)
      ? name
      : "*[local-name()=" + xpathLiteral(name) + ']';
  }

  function xpathEvidencePart(item) {
    if (!item || item.bridge) return null;
    if (item.type === 'tag') return { kind: 'tag', value: xpathNameFor(item.node), item };
    if (item.type === 'text') {
      return { kind: 'predicate', value: '[contains(string(),' + xpathLiteral(item.value) + ')]', item };
    }
    if (item.type === 'pos') return {
      kind: 'predicate',
      value: '[' + Math.max(1, Number(item.value) || xpathNodePosition(item.node)) + ']',
      item
    };
    if (item.type === 'attribOnly') {
      return { kind: 'predicate', value: '[@' + item.name + ']', item };
    }
    if (!item.type.startsWith('attrib')) return null;
    const value = xpathLiteral(item.value);
    if (item.name === 'class') {
      if (item.type === 'attrib') {
        return {
          kind: 'predicate',
          value: "[contains(concat(' ', normalize-space(@class), ' '), " + xpathLiteral(' ' + item.value + ' ') + ')]',
          item
        };
      }
      return { kind: 'predicate', value: '[contains(@class,' + value + ')]', item };
    }
    if (item.type === 'attrib') return { kind: 'predicate', value: '[@' + item.name + '=' + value + ']', item };
    if (item.type === 'attribStart') return { kind: 'predicate', value: '[starts-with(@' + item.name + ',' + value + ')]', item };
    if (item.type === 'attribEnd') {
      // XPath 1.0 has no ends-with(). The length guard retains exact suffix
      // semantics without relying on a browser-specific XPath extension.
      return {
        kind: 'predicate',
        value: '[substring(@' + item.name + ', string-length(@' + item.name + ') - string-length(' + value + ') + 1) = ' + value + ']',
        item
      };
    }
    return { kind: 'predicate', value: '[contains(@' + item.name + ',' + value + ')]', item };
  }

  function xpathNodeCandidates(evidence, allowedIds = null, tokenOrder = null) {
    const parts = evidence
      .filter((item) => !allowedIds || allowedIds.has(item.id))
      .map(xpathEvidencePart)
      .filter(Boolean)
      .sort((left, right) => {
        const leftOrder = tokenOrder?.get(left.item.id) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = tokenOrder?.get(right.item.id) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder
          || (left.item.rankCost ?? 0) - (right.item.rankCost ?? 0)
          || left.item.id.localeCompare(right.item.id);
      });
    const tags = parts.filter((part) => part.kind === 'tag');
    const predicates = parts.filter((part) => part.kind === 'predicate');
    const candidates = new Map();
    const add = (test, used) => {
      if (!test) return;
      const tokenIds = used.map((part) => part.item.id);
      const cost = used.reduce((sum, part) => sum + (part.item.rankCost ?? 1), 0);
      const order = tokenOrder
        ? Math.min(...tokenIds.map((id) => tokenOrder.get(id) ?? Number.MAX_SAFE_INTEGER))
        : 0;
      const previous = candidates.get(test);
      if (!previous || order < previous.order || (order === previous.order && cost < previous.cost)) {
        candidates.set(test, { test, tokenIds, cost, order });
      }
    };

    for (const tag of tags) add(tag.value, [tag]);
    for (const predicate of predicates) add('*' + predicate.value, [predicate]);
    for (const tag of tags.slice(0, 4)) {
      for (const predicate of predicates.slice(0, 12)) add(tag.value + predicate.value, [tag, predicate]);
    }
    // Two complementary semantic attributes often distinguish repeated cards
    // without falling back to their array position.
    for (let index = 0; index < Math.min(predicates.length, 8); index += 1) {
      for (let next = index + 1; next < Math.min(predicates.length, 8); next += 1) {
        add('*' + predicates[index].value + predicates[next].value, [predicates[index], predicates[next]]);
      }
    }

    // Some repeated cards can only be identified by three or more independent
    // predicates.  Keep adding the ordered evidence to a candidate chain so
    // the synthesizer can express an arbitrary conjunction instead of falling
    // back to a brittle absolute position after the two-predicate cases.
    // The cap bounds pathological class/attribute token sets while still
    // covering every normal HTML attribute slot (which is capped at 15).
    const accumulated = [];
    const accumulationLimit = Math.min(predicates.length, 24);
    for (let index = 0; index < accumulationLimit; index += 1) {
      accumulated.push(predicates[index]);
      if (accumulated.length < 3) continue;
      const predicatePath = accumulated.map((part) => part.value).join('');
      add('*' + predicatePath, accumulated);
      for (const tag of tags.slice(0, 4)) {
        add(tag.value + predicatePath, [tag, ...accumulated]);
      }
    }
    return [...candidates.values()]
      .sort((left, right) => left.order - right.order || left.cost - right.cost || left.test.length - right.test.length || left.test.localeCompare(right.test));
  }

  function xpathFollowingSibling(test, immediate) {
    // `following-sibling::span[1]` means "the first following span", not
    // "the immediately following element is a span".  Start at `*` for the
    // latter so sibling evidence preserves CSS `+` semantics exactly.
    return immediate
      ? '/following-sibling::*[1][self::' + test + ']'
      : '/following-sibling::' + test;
  }

  function xpathSiblingLaneCandidates(route, localLevel, allowedIds, allowImplicitWildcard, tokenOrder = null) {
    const at = (offset) => xpathNodeCandidates(route.evidence.filter((item) => (
      !item.bridge && item.localLevel === localLevel && item.offset === offset
    )), allowedIds, tokenOrder);
    const own = at(0);
    const endpoint = own.length
      ? own
      : allowImplicitWildcard ? [{ test: '*', tokenIds: [], cost: 24, order: Number.MAX_SAFE_INTEGER }] : [];
    const previous = at(-1).slice(0, 12);
    const beforePrevious = at(-2).slice(0, 12);
    const candidates = new Map();
    const add = (test, used) => {
      if (!test) return;
      const tokenIds = used.flatMap((candidate) => candidate.tokenIds || []);
      const cost = used.reduce((sum, candidate) => sum + (candidate.cost || 0), 0);
      const order = used.reduce((minimum, candidate) => Math.min(minimum, candidate.order ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
      const prior = candidates.get(test);
      if (!prior || order < prior.order || (order === prior.order && cost < prior.cost)) {
        candidates.set(test, { test, tokenIds, cost, order });
      }
    };

    endpoint.forEach((candidate) => add(candidate.test, [candidate]));
    for (const sibling of previous) {
      for (const target of endpoint) {
        add(
          sibling.test + xpathFollowingSibling(target.test, route.isImmediateSiblingStep(localLevel, -1, 0)),
          [sibling, target]
        );
      }
    }
    for (const sibling of beforePrevious) {
      for (const target of endpoint) {
        add(
          sibling.test + xpathFollowingSibling(target.test, route.isImmediateSiblingStep(localLevel, -2, 0)),
          [sibling, target]
        );
      }
      for (const middle of previous) {
        for (const target of endpoint) {
          add(
            sibling.test
              + xpathFollowingSibling(middle.test, route.isImmediateSiblingStep(localLevel, -2, -1))
              + xpathFollowingSibling(target.test, route.isImmediateSiblingStep(localLevel, -1, 0)),
            [sibling, middle, target]
          );
        }
      }
    }
    return [...candidates.values()]
      .sort((left, right) => left.order - right.order || left.cost - right.cost || left.test.length - right.test.length || left.test.localeCompare(right.test));
  }

  function xpathPrefix(root) {
    return isElement(root) ? './/' : '//';
  }

  function sameElements(left, right) {
    return left.length === right.length && left.every((node, index) => node === right[index]);
  }

  function xpathStructuralPath(target, root, options) {
    if (target === root) return '.';
    const chain = [];
    for (let current = target; isElement(current); current = current.parentElement) {
      if (current === root) break;
      const position = xpathNodePosition(current);
      const depth = chain.length;
      const allowTag = callbackAllows(options, 'tag', current.localName, '', depth, 0);
      const allowPosition = callbackAllows(options, 'pos', current.localName, String(position), depth, 0);
      if (!allowTag && !allowPosition) return '';
      const name = allowTag ? xpathNameFor(current) : '*';
      chain.push(name + (allowPosition ? '[' + position + ']' : ''));
      if (current === current.ownerDocument?.documentElement) break;
    }
    if (!chain.length) return '';
    const path = chain.reverse().join('/');
    return isElement(root) ? './' + path : '//' + path;
  }

  function prepareXPathSynthesis(elements, rawOptions) {
    const selected = documentOrder(asElements(elements));
    if (!selected.length) return null;
    const options = normalizeOptions(rawOptions);
    const context = createContext(selected, options);
    if (selected.some((element) => isShadowRoot(element.getRootNode?.()))) {
      throw new Error('XPath cannot cross a shadow-root boundary; use extended CSS instead');
    }
    const configured = configuredRoot(rawOptions);
    const root = isElement(configured) || isDocument(configured)
      ? configured
      : selected[0].ownerDocument;
    const routes = selected.map((element) => new Route(element, context.root, context.options));
    // XPath plugins receive the same evidence metrics as CSS plugins. This is
    // especially important when a sorter ranks sharedness or target distance.
    routes.forEach((route) => decorateEvidence(route, routes));
    const evidenceById = new Map();
    for (const route of routes) {
      for (const evidence of route.evidence) {
        if (!evidence.bridge && !evidenceById.has(evidence.id)) evidenceById.set(evidence.id, evidence);
      }
    }
    const allEvidence = [...evidenceById.values()]
      .sort((left, right) => left.rankCost - right.rankCost || left.css.length - right.css.length || left.id.localeCompare(right.id));
    return { selected, options: context.options, root, routes, allEvidence };
  }

  function orderedXPathEvidence(prepared, suppliedTokens = null) {
    if (!Array.isArray(suppliedTokens)) return prepared.allEvidence;
    const byId = new Map(prepared.allEvidence.map((item) => [item.id, item]));
    return suppliedTokens
      .map((token) => byId.get(typeof token === 'string' ? token : token?.id))
      .filter((item, index, values) => item && values.indexOf(item) === index);
  }

  function synthesizeXPath(prepared, suppliedTokens = null) {
    const orderedEvidence = orderedXPathEvidence(prepared, suppliedTokens);
    const allowed = new Set(orderedEvidence.map((item) => item.id));
    const tokenSetIsAuthoritative = Array.isArray(suppliedTokens);
    const tokenOrder = tokenSetIsAuthoritative
      ? new Map(orderedEvidence.map((item, index) => [item.id, index]))
      : null;
    // A non-empty sorter result may intentionally retain only sibling or
    // ancestor evidence, in which case `*` is a necessary structural tail.
    // An empty result, however, explicitly suppresses every atom and must not
    // be bypassed by a hidden absolute XPath fallback.
    const allowImplicitWildcard = !tokenSetIsAuthoritative || allowed.size > 0;
    const selectedSet = new Set(prepared.selected);
    const candidates = new Map();
    const add = (expression, cost, tokenIds = []) => {
      if (!expression) return;
      const order = tokenOrder
        ? Math.min(...tokenIds.map((id) => tokenOrder.get(id) ?? Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
        : 0;
      const prior = candidates.get(expression);
      if (!prior || order < prior.order || (order === prior.order && cost < prior.cost)) {
        candidates.set(expression, { expression, cost, tokenIds, order });
      }
    };
    const prefix = xpathPrefix(prepared.root);

    for (const route of prepared.routes) {
      if (route.target === prepared.root) {
        add('.', 0, []);
      }
      const targetEvidence = route.evidence.filter((item) => !item.bridge && item.localLevel === 0 && item.offset === 0);
      const targetTests = xpathNodeCandidates(targetEvidence, allowed, tokenOrder);
      const targetOrWildcard = targetTests.length
        ? targetTests
        : allowImplicitWildcard ? [{ test: '*', tokenIds: [], cost: 24, order: Number.MAX_SAFE_INTEGER }] : [];
      const targetLanes = xpathSiblingLaneCandidates(route, 0, allowed, allowImplicitWildcard, tokenOrder);
      for (const target of targetLanes) add(prefix + target.test, target.cost, target.tokenIds);

      const levels = [...new Set(route.evidence.filter((item) => !item.bridge && item.offset === 0 && item.localLevel > 0).map((item) => item.localLevel))]
        .sort((left, right) => left - right)
        .slice(0, 8);
      for (const level of levels) {
        const ancestors = xpathSiblingLaneCandidates(route, level, allowed, allowImplicitWildcard, tokenOrder);
        for (const ancestor of ancestors.slice(0, 16)) {
          for (const target of targetOrWildcard.slice(0, 18)) {
            add(prefix + ancestor.test + '//' + target.test, ancestor.cost + target.cost + level * 0.25, [...ancestor.tokenIds, ...target.tokenIds]);
          }
        }
      }

    }

    const usable = [];
    for (const candidate of candidates.values()) {
      let matches;
      try {
        matches = evaluateXPath(candidate.expression, prepared.root).filter(isElement);
      } catch {
        continue;
      }
      const unique = documentOrder([...new Set(matches)]);
      const covered = unique.filter((node) => selectedSet.has(node));
      if (!covered.length || unique.some((node) => !selectedSet.has(node))) continue;
      usable.push({ ...candidate, matches: unique, covered });
    }

    const pending = new Set(prepared.selected);
    const branches = [];
    while (pending.size) {
      const best = usable
        .filter((candidate) => candidate.covered.some((node) => pending.has(node)))
        .sort((left, right) => {
          const leftCoverage = left.covered.filter((node) => pending.has(node)).length;
          const rightCoverage = right.covered.filter((node) => pending.has(node)).length;
          return rightCoverage - leftCoverage
            || left.order - right.order
            || left.cost - right.cost
            || left.expression.length - right.expression.length
            || left.expression.localeCompare(right.expression);
        })[0];
      if (!best) {
        if (tokenSetIsAuthoritative) {
          throw new Error('Could not derive an XPath selector from the permitted tokens');
        }
        const target = [...pending][0];
        const structural = xpathStructuralPath(target, prepared.root, prepared.options);
        if (!structural) throw new Error('Could not derive a stable XPath selector for the selected element');
        const matches = evaluateXPath(structural, prepared.root).filter(isElement);
        if (!sameElements(matches, [target])) throw new Error('Could not derive a stable XPath selector for the selected element');
        branches.push(structural);
        pending.delete(target);
        continue;
      }
      branches.push(best.expression);
      best.covered.forEach((node) => pending.delete(node));
      if (branches.length > prepared.selected.length) throw new Error('XPath synthesis did not converge');
    }
    return [...new Set(branches)].join(' | ');
  }

  function getXPATHSync(elements, rawOptions) {
    const prepared = prepareXPathSynthesis(elements, rawOptions);
    if (!prepared) return '';
    if (typeof rawOptions?.tokenSorter !== 'function') return synthesizeXPath(prepared);
    const supplied = rawOptions.tokenSorter(prepared.allEvidence.map((item) => item.asSorterToken()));
    if (supplied && typeof supplied.then === 'function') {
      throw new Error('An asynchronous tokenSorter requires getXPATH()');
    }
    return synthesizeXPath(prepared, Array.isArray(supplied) ? supplied : null);
  }

  function getXPATH(elements, rawOptions) {
    return Promise.resolve().then(async () => {
      const prepared = prepareXPathSynthesis(elements, rawOptions);
      if (!prepared) return '';
      if (typeof rawOptions?.tokenSorter !== 'function') return synthesizeXPath(prepared);
      const supplied = await rawOptions.tokenSorter(prepared.allEvidence.map((item) => item.asSorterToken()));
      return synthesizeXPath(prepared, Array.isArray(supplied) ? supplied : null);
    });
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
        // CSS and XCSS selectors are element selectors. Preserve that common
        // contract for XPath too; raw XPath attribute/text-node queries remain
        // available through evaluateXPath() for capture-specific handling.
        return Promise.resolve(evaluateXPath(this.value, root).filter(isElement));
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
    const intrinsicRoot = nodes[0].getRootNode?.();
    if (isShadowRoot(intrinsicRoot) && nodes.every((node) => node.getRootNode?.() === intrinsicRoot)) {
      return intrinsicRoot;
    }
    let root = nodes[0].ownerDocument.documentElement;
    while (true) {
      const candidate = [...root.children].find((child) => (
        !nodes.includes(child) && nodes.every((node) => child.contains(node))
      ));
      if (!candidate) break;
      root = candidate;
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

    _interactiveOptions(root = undefined) {
      // Stateful add/reject prediction is deliberately conservative. Partial
      // attributes and preceding-sibling lanes are useful for one-shot full
      // synthesis, but make an interactive selection jump as neighboring DOM
      // content changes.
      return {
        ...this.options,
        ...(root === undefined ? {} : { root }),
        partAttrib: false,
        siblingNodes: false,
        useText: false
      };
    }

    _commonCandidates(root) {
      const desired = this.selected;
      if (!desired.length) return [];
      const context = createContext(desired, {
        ...normalizeOptions(this._interactiveOptions(root)),
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
      // Validate the shared document/root relationship before trying friendly
      // fallbacks. A bad root or cross-document set is a configuration error,
      // not a reason to silently emit a selector for a different subtree.
      createContext(selected, { ...normalizeOptions(this._interactiveOptions(root)), root });
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
          css = await getCSS(selected, this._interactiveOptions(root));
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
      const root = interactiveRoot(desired, this.options.root);
      createContext(desired, { ...normalizeOptions(this._interactiveOptions(root)), root });
      this.reset();
      for (const element of desired) this._selected.add(element);
      this._latestAction = SelectorX.ADDED_SELECTION;
      // A set operation is expected to converge on exactly the supplied set,
      // so use the full synthesizer once and retain any other candidates as
      // explicit rejections for subsequent interactive edits.
      try {
        this._selector = await getCSS(desired, this._interactiveOptions(root));
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
