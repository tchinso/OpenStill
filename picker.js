(() => {
  const INSTANCE_KEY = '__openStillPickerInstance__';

  if (globalThis[INSTANCE_KEY]) {
    globalThis[INSTANCE_KEY].activate();
    return;
  }

  const MAX_HIGHLIGHTS = 20;
  const MAX_SELECTIONS = 20;
  // The quick pass runs while the pointer is moving.  The full pass only runs
  // when an element is committed, so it can spend more work finding a concise
  // semantic path instead of falling back to a brittle chain of nth-childs.
  const SELECTOR_SEARCH = Object.freeze({
    quick: { queryBudget: 180, beamWidth: 28, maxParts: 4 },
    full: { queryBudget: 2_400, beamWidth: 112, maxParts: 7 }
  });
  const selectorCache = new WeakMap();

  function cleanText(value, maxLength = 10_000) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function cleanSnapshotText(value, maxLength = 10_000) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, maxLength);
  }

  function snapshotTextFor(element) {
    return cleanSnapshotText(element?.innerText || element?.textContent);
  }

  function isPageElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    let root = element.getRootNode();
    while (root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host) {
      root = root.host.getRootNode();
    }
    return root === document;
  }

  function composedContains(ancestor, descendant) {
    for (let current = descendant; current;) {
      if (current === ancestor) return true;
      if (current.parentElement) {
        current = current.parentElement;
      } else {
        const root = current.getRootNode?.();
        current = root?.host || null;
      }
    }
    return false;
  }

  function composedOrder(left, right) {
    if (left === right) return 0;
    if (composedContains(left, right)) return -1;
    if (composedContains(right, left)) return 1;
    const outerHost = (element) => {
      let current = element;
      let root = current.getRootNode();
      while (root?.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host) {
        current = root.host;
        root = current.getRootNode();
      }
      return current;
    };
    const outerLeft = outerHost(left);
    const outerRight = outerHost(right);
    if (outerLeft !== outerRight) {
      const position = outerLeft.compareDocumentPosition(outerRight);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    }
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function normalizedSelectorType(value) {
    const type = String(value || 'css').trim().toLowerCase();
    if (type === 'extended-css' || type === 'extendedcss') return 'xcss';
    return ['css', 'xcss', 'xpath'].includes(type) ? type : 'css';
  }

  // CSS and XCSS intentionally have different reach.  A normal CSS locator
  // must stay in its native tree; only XCSS is allowed to cross a shadow-root
  // boundary.  Treating every preview as XCSS made a CSS rule look valid in
  // the picker even though the capture worker would later find nothing.
  function queryTrackedElements(selector, root = document, selectorType = 'css') {
    const type = normalizedSelectorType(selectorType);
    const runtime = globalThis.__openStillSelectorX;
    if (type === 'xpath') {
      if (typeof runtime?.evaluateXPath === 'function') {
        return Array.from(runtime.evaluateXPath(selector, root)).filter((node) => node instanceof Element);
      }
      const doc = root?.nodeType === Node.DOCUMENT_NODE ? root : root?.ownerDocument;
      if (!doc?.evaluate) return [];
      const result = doc.evaluate(selector, root, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
      const matches = [];
      for (let node = result.iterateNext(); node; node = result.iterateNext()) {
        if (node instanceof Element) matches.push(node);
      }
      return matches;
    }
    if (type === 'xcss') {
      const runtimeQuery = runtime?.querySelectorAll ?? runtime?.queryExtendedCSS;
      if (typeof runtimeQuery === 'function') return Array.from(runtimeQuery(selector, root));
    }
    return Array.from(root.querySelectorAll(selector));
  }

  function shadowRootFor(element) {
    if (!(element instanceof Element)) return null;
    try {
      return element.shadowRoot
        || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element)
        || null;
    } catch {
      return element.shadowRoot || null;
    }
  }

  function deepestShadowElementAtPoint(element, clientX, clientY) {
    let current = element;
    const visitedRoots = new Set();
    while (current instanceof Element) {
      const shadow = shadowRootFor(current);
      if (!shadow || visitedRoots.has(shadow) || typeof shadow.elementFromPoint !== 'function') break;
      visitedRoots.add(shadow);
      const nested = shadow.elementFromPoint(clientX, clientY);
      if (!(nested instanceof Element) || nested === current) break;
      current = nested;
    }
    return current;
  }

  function selectorTypeFor(element) {
    return element?.getRootNode?.()?.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? 'xcss' : 'css';
  }

  function uniqueElementsInDocumentOrder(elements) {
    const unique = [...new Set(Array.from(elements ?? []).filter(isPageElement))];
    return unique.sort(composedOrder);
  }

  function removeNestedElements(elements) {
    const ordered = uniqueElementsInDocumentOrder(elements);
    return ordered.filter((element, index) => !ordered
      .slice(0, index)
      .some((ancestor) => composedContains(ancestor, element)));
  }

  function snapshotTextForElements(elements) {
    return cleanSnapshotText(uniqueElementsInDocumentOrder(elements)
      .map((element) => snapshotTextFor(element))
      .filter(Boolean)
      .join('\n\n'));
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

  function hasSingleMatch(selector, element, selectorType = selectorTypeFor(element)) {
    try {
      const matches = queryTrackedElements(selector, document, selectorType);
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

  function addSelectorFeature(features, css, cost, { semantic = false, positional = false } = {}) {
    if (!css || css.length > 180) return;
    const prior = features.get(css);
    if (!prior || cost < prior.cost) {
      features.set(css, { css, cost, semantic, positional });
    } else if (cost === prior.cost && (semantic || positional)) {
      features.set(css, {
        ...prior,
        semantic: prior.semantic || semantic,
        positional: prior.positional || positional
      });
    }
  }

  function selectorFeatures(element, maxFeatures = 20) {
    const tag = element.localName?.toLowerCase();
    if (!tag || tag.startsWith('openstill-')) return [];
    const features = new Map();

    if (element.id && isSemanticIdentifier(element.id)) {
      addSelectorFeature(features, '#' + escapeCss(element.id), 0.7, { semantic: true });
    }

    const attributeNames = new Set([
      'data-testid', 'data-test', 'data-cy', 'data-qa', 'data-id',
      'name', 'role', 'type', 'for', 'aria-label', 'aria-labelledby', 'title'
    ]);
    for (const attribute of element.attributes) {
      if (/^data-[a-z][a-z0-9_-]*$/i.test(attribute.name)) {
        attributeNames.add(attribute.name);
      }
    }
    for (const name of attributeNames) {
      const value = element.getAttribute(name);
      if (value && isSafeSelectorAttribute(value)) {
        const attribute = '[' + name + "='" + escapeCssString(value) + "']";
        addSelectorFeature(features, attribute, 2.2, { semantic: true });
        addSelectorFeature(features, tag + attribute, 2.8, { semantic: true });
      }
    }

    const stableClasses = [...element.classList].filter(isSemanticClass);
    for (const className of stableClasses) {
      const cssClass = '.' + escapeCss(className);
      addSelectorFeature(features, cssClass, 3.1, { semantic: true });
      addSelectorFeature(features, tag + cssClass, 3.9, { semantic: true });
    }
    for (let index = 0; index < Math.min(stableClasses.length, 5); index += 1) {
      for (let next = index + 1; next < Math.min(stableClasses.length, 5); next += 1) {
        addSelectorFeature(
          features,
          '.' + escapeCss(stableClasses[index]) + '.' + escapeCss(stableClasses[next]),
          5.1,
          { semantic: true }
        );
      }
    }

    for (const className of element.classList) {
      for (const fragment of partialClassFragments(className)) {
        const partial = "[class*='" + escapeCssString(fragment) + "']";
        addSelectorFeature(features, partial, 5.8, { semantic: true });
        addSelectorFeature(features, tag + partial, 6.4, { semantic: true });
      }
    }

    const childPosition = elementChildPosition(element);
    const typePosition = elementTypePosition(element);
    if (childPosition === 1) {
      addSelectorFeature(features, tag + ':first-child', 8.2, { positional: true });
    } else if (element.parentElement?.lastElementChild === element) {
      addSelectorFeature(features, tag + ':last-child', 8.5, { positional: true });
    } else if (childPosition) {
      addSelectorFeature(
        features,
        tag + ':nth-child(' + childPosition + ')',
        14 + Math.min(childPosition, 8) * 0.3,
        { positional: true }
      );
    }
    if (typePosition === 1 && childPosition !== 1) {
      addSelectorFeature(features, tag + ':first-of-type', 10.8, { positional: true });
    } else if (typePosition && typePosition > 1) {
      addSelectorFeature(
        features,
        tag + ':nth-of-type(' + typePosition + ')',
        15 + Math.min(typePosition, 8) * 0.3,
        { positional: true }
      );
    }
    addSelectorFeature(features, tag, 12);

    const ordered = [...features.values()]
      .sort((left, right) => left.cost - right.cost || left.css.length - right.css.length || left.css.localeCompare(right.css));
    const positional = ordered.filter((feature) => feature.positional);
    const ordinary = ordered.filter((feature) => !feature.positional);
    return [...ordinary.slice(0, Math.max(1, maxFeatures - positional.length)), ...positional]
      .sort((left, right) => left.cost - right.cost || left.css.length - right.css.length || left.css.localeCompare(right.css));
  }

  function inspectCandidate(selector, target, cache, budget, selectorType = selectorTypeFor(target)) {
    const cacheKey = normalizedSelectorType(selectorType) + '\u0000' + selector;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    if (budget.used >= budget.limit || selector.length > 340) {
      return { containsTarget: false, count: 0 };
    }
    budget.used += 1;
    try {
      const matches = queryTrackedElements(selector, document, selectorType);
      const result = { containsTarget: matches.includes(target), count: matches.length };
      cache.set(cacheKey, result);
      return result;
    } catch {
      const result = { containsTarget: false, count: 0 };
      cache.set(cacheKey, result);
      return result;
    }
  }

  function candidateRank(candidate) {
    const semanticParts = candidate.semanticParts ?? 0;
    const positionalParts = candidate.positionalParts ?? 0;
    const directParts = candidate.directParts ?? 0;
    const parts = candidate.parts ?? 1;
    // Positional and direct-child links are useful tie-breakers, but they are
    // the first things to become stale when a list is re-rendered.  Prefer a
    // path that explains the target with semantic classes/attributes instead.
    return candidate.cost
      + positionalParts * 2.4
      + directParts * 1.1
      + Math.max(0, parts - semanticParts - 1) * 0.6
      - Math.min(semanticParts, 3) * 0.9;
  }

  function candidateIsBetter(candidate, best) {
    if (!best) return true;
    const candidateScore = candidateRank(candidate);
    const bestScore = candidateRank(best);
    if (candidateScore !== bestScore) return candidateScore < bestScore;
    if ((candidate.semanticParts ?? 0) !== (best.semanticParts ?? 0)) {
      return (candidate.semanticParts ?? 0) > (best.semanticParts ?? 0);
    }
    if (candidate.cost !== best.cost) return candidate.cost < best.cost;
    if (candidate.css.length !== best.css.length) return candidate.css.length < best.css.length;
    return candidate.css.localeCompare(best.css) < 0;
  }

  function semanticFallbackFeatures(element, limit, { allowNeutral = false } = {}) {
    const features = selectorFeatures(element, limit);
    const semantic = features.filter((feature) => feature.semantic);
    const positions = features.filter((feature) => feature.positional);
    const neutral = allowNeutral
      ? features.filter((feature) => !feature.semantic && !feature.positional).slice(0, 1)
      : [];
    return [...semantic, ...positions.slice(0, 2), ...neutral];
  }

  function semanticDescendantFallback(element, selectorType = selectorTypeFor(element)) {
    const path = [];
    for (let current = element; current && path.length < 12; current = current.parentElement) {
      path.push(current);
      if (current === document.body) break;
    }

    const queryCache = new Map();
    const budget = { used: 0, limit: 900 };
    const leafFeatures = semanticFallbackFeatures(element, 30, { allowNeutral: true });
    let best = null;
    let frontier = [];
    const visited = new Set();

    for (const feature of leafFeatures) {
      visited.add(`0\u0000${feature.css}`);
      const inspection = inspectCandidate(feature.css, element, queryCache, budget, selectorType);
      if (!inspection.containsTarget) continue;
      const state = {
        css: feature.css,
        cost: feature.cost,
        outerIndex: 0,
        count: inspection.count,
        semanticParts: feature.semantic ? 1 : 0,
        positionalParts: feature.positional ? 1 : 0,
        directParts: 0,
        parts: 1
      };
      if (inspection.count === 1 && state.semanticParts > 0) {
        if (candidateIsBetter(state, best)) best = state;
      } else {
        frontier.push(state);
      }
    }

    for (let round = 1; frontier.length && round < 8 && budget.used < budget.limit; round += 1) {
      const next = [];
      const ranked = frontier
        .sort((left, right) => candidateRank(left) + Math.log2(left.count + 1)
          - candidateRank(right) - Math.log2(right.count + 1))
        .slice(0, 72);
      for (const state of ranked) {
        for (let pathIndex = state.outerIndex + 1; pathIndex < path.length; pathIndex += 1) {
          for (const feature of semanticFallbackFeatures(path[pathIndex], 24)) {
            const css = feature.css + ' ' + state.css;
            const key = `${pathIndex}\u0000${css}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const inspection = inspectCandidate(css, element, queryCache, budget, selectorType);
            if (!inspection.containsTarget) continue;
            const nextState = {
              css,
              cost: state.cost + feature.cost + 0.35,
              outerIndex: pathIndex,
              count: inspection.count,
              semanticParts: state.semanticParts + (feature.semantic ? 1 : 0),
              positionalParts: state.positionalParts + (feature.positional ? 1 : 0),
              directParts: state.directParts,
              parts: state.parts + 1
            };
            if (inspection.count === 1 && nextState.semanticParts > 0) {
              if (candidateIsBetter(nextState, best)) best = nextState;
            } else {
              next.push(nextState);
            }
          }
          if (budget.used >= budget.limit) break;
        }
      }
      frontier = next
        .sort((left, right) => candidateRank(left) + Math.log2(left.count + 1)
          - candidateRank(right) - Math.log2(right.count + 1))
        .slice(0, 72);
    }

    return best?.css || '';
  }

  function strictSelectorFallback(element, { preferSemantic = true, selectorType = selectorTypeFor(element) } = {}) {
    if (preferSemantic) {
      const semanticSelector = semanticDescendantFallback(element, selectorType);
      if (semanticSelector) return semanticSelector;
    }

    const parts = [];
    let current = element;
    for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
      const tag = current.localName?.toLowerCase() || '*';
      if (current.id && isSemanticIdentifier(current.id)) {
        parts.unshift('#' + escapeCss(current.id));
        break;
      }
      const position = elementChildPosition(current);
      parts.unshift(position ? tag + ':nth-child(' + position + ')' : tag);
      if (current === document.documentElement) break;
    }
    return parts.join(' > ');
  }

  function selectorStructuralPenalty(selector) {
    if (!selector) return Number.POSITIVE_INFINITY;
    const directLinks = (selector.match(/\s>\s/g) ?? []).length;
    const nthParts = (selector.match(/:nth-(?:child|of-type)\(/g) ?? []).length;
    const positionalParts = (selector.match(/:(?:first|last)(?:-of-type|-child)?|:nth-(?:child|of-type)\(/g) ?? []).length;
    const parts = selector.trim().split(/\s+(?:>\s+)?/).filter(Boolean).length;
    return directLinks * 7 + nthParts * 8 + positionalParts * 1.5 + Math.max(0, parts - 4) * 0.5;
  }

  function selectorFor(element, { quick = false } = {}) {
    if (!isPageElement(element)) {
      return '';
    }

    const selectorType = selectorTypeFor(element);
    const cached = selectorCache.get(element) ?? {};
    if (!quick && cached.full && hasSingleMatch(cached.full, element, selectorType)) return cached.full;
    if (quick && cached.quick && hasSingleMatch(cached.quick, element, selectorType)) return cached.quick;
    if (quick && cached.full && hasSingleMatch(cached.full, element, selectorType)) return cached.full;

    // The selector engine evaluates candidates against the DOM and removes
    // constraints that do not contribute to uniqueness. In particular, do not
    // fall through to a full parent > nth-child chain when a utility-class
    // heavy list needs partial class attributes.
    if (!quick) {
      try {
        const selectorGenerator = globalThis.__openStillSelectorX?.getExtendedCSSSync
          ?? globalThis.__openStillSelectorX?.getExtendedCSS;
        const selector = typeof selectorGenerator === 'function'
          ? selectorGenerator([element], {
            timeout: 500,
            filterCallback: (_tokenType, name, value) => ![
              'href', 'src', 'srcset', 'hasinclude__', 'include__', 'title', 'aria-label', 'alt'
            ].includes(name) && !(value?.length > 30)
          })
          : '';
        if (typeof selector === 'string' && selector && hasSingleMatch(selector, element, selectorType)) {
          cached.full = selector;
          selectorCache.set(element, cached);
          return selector;
        }
      } catch (error) {
        console.warn('OpenStill selector generation failed.', error);
      }

      // The token-tree generator can time out on a very large or frequently
      // mutating page.  Do not discard a demonstrably unique semantic path in
      // that case; unlike the old parent > nth-child fallback, this helper
      // requires at least one stable-looking ID, attribute, or class.
      const semanticSelector = semanticDescendantFallback(element, selectorType);
      if (semanticSelector && hasSingleMatch(semanticSelector, element, selectorType)) {
        cached.full = semanticSelector;
        selectorCache.set(element, cached);
        return semanticSelector;
      }
      return '';
    }

    const config = quick ? SELECTOR_SEARCH.quick : SELECTOR_SEARCH.full;
    const maxFeatures = quick ? 16 : 28;
    const path = [];
    const maxPathDepth = quick ? 8 : 12;
    for (let current = element; current && path.length < maxPathDepth; current = current.parentElement) {
      path.push(current);
      if (current === document.body) break;
    }
    const queryCache = new Map();
    const budget = { used: 0, limit: config.queryBudget };
    let best = null;
    let frontier = [];

    for (const feature of selectorFeatures(element, maxFeatures)) {
      const inspection = inspectCandidate(feature.css, element, queryCache, budget, selectorType);
      if (!inspection.containsTarget) continue;
      const state = {
        css: feature.css,
        cost: feature.cost,
        outerIndex: 0,
        count: inspection.count,
        semanticParts: feature.semantic ? 1 : 0,
        positionalParts: feature.positional ? 1 : 0,
        directParts: 0,
        parts: 1
      };
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
        .sort((left, right) => (
          candidateRank(left) + Math.log2(left.count + 1)
          - candidateRank(right) - Math.log2(right.count + 1)
        ))
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
          const inspection = inspectCandidate(css, element, queryCache, budget, selectorType);
              if (!inspection.containsTarget) continue;
              const nextState = {
                css,
                cost: state.cost + feature.cost + (connector === ' > ' ? 2.1 : 0.55),
                outerIndex: pathIndex,
                count: inspection.count,
                semanticParts: state.semanticParts + (feature.semantic ? 1 : 0),
                positionalParts: state.positionalParts + (feature.positional ? 1 : 0),
                directParts: state.directParts + (connector === ' > ' ? 1 : 0),
                parts: state.parts + 1
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
        .sort((left, right) => (
          candidateRank(left) + Math.log2(left.count + 1)
          - candidateRank(right) - Math.log2(right.count + 1)
        ))
        .slice(0, config.beamWidth);
    }

    let selector = best?.css || '';
    // A semantic descendant path is often less brittle than a technically
    // valid direct-child chain on utility-class-heavy list pages.  Prefer it
    // only when it meaningfully removes structural constraints.
    if (!quick) {
      const semanticSelector = semanticDescendantFallback(element, selectorType);
      if (semanticSelector && selectorStructuralPenalty(semanticSelector) + 0.5 < selectorStructuralPenalty(selector)) {
        selector = semanticSelector;
      }
    }
    // Never save the old direct-child structural fallback. It is technically
    // unique today but is exactly the form that breaks when a list gains a
    // card or a wrapper. If the selector engine cannot produce a valid
    // selector, let the picker ask the user to choose again instead.
    if (!selector && quick) selector = strictSelectorFallback(element, { preferSemantic: true, selectorType });
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
          .selector-row select { width: 108px; flex: 0 0 108px; }
          .field-controls { display: grid; grid-template-columns: 1fr 1.35fr; gap: 8px; }
          .field-controls label { color: #aebed2; }
          .field-controls [hidden] { display: none; }
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
          .match.selected.excluded { border-color: #ff8b7b; background: rgb(255 92 92 / 12%); border-style: dashed; }
          .schedule { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          .schedule[hidden] { display: none; }
          .interval-fields { display: grid; gap: 6px; color: #c8d5e6; font-size: 12px; font-weight: 650; }
          .interval-fields[hidden] { display: none; }
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
              <p class="notice">요소를 여러 개 고른 뒤 한 번에 저장할 수 있습니다. 선택자 결과 전체는 한 주소의 목록으로 함께 비교됩니다.</p>
              <p class="selection-summary" id="selectionSummary">선택한 요소 0개</p>
              <div class="selection-list" id="selectionList"></div>
              <label>CSS 선택자
                <div class="selector-row"><select id="selectorType" aria-label="Selector type"><option value="css">CSS</option><option value="xcss">XCSS (Shadow DOM)</option><option value="xpath">XPath</option></select><input id="selector" autocomplete="off" spellcheck="false" /></div>
              </label>
              <div class="field-controls" aria-label="추출할 값">
                <label>추출 값<select id="fieldType" aria-label="추출 값"><option value="text">텍스트</option><option value="attribute">속성</option><option value="property">프로퍼티</option></select></label>
                <label id="fieldNameLabel">이름<input id="fieldName" autocomplete="off" spellcheck="false" maxlength="80" placeholder="예: href, value"></label>
              </div>
              <div class="validity" id="validity">선택자를 확인하는 중입니다.</div>
              <label>표시 이름 <span style="font-weight:500;color:#7e91aa">여러 개면 번호를 붙여 저장</span><input id="name" name="name" maxlength="120" /></label>
              <label>라벨 <span style="font-weight:500;color:#7e91aa">쉼표로 여러 개를 구분</span><input id="labels" name="labels" maxlength="500" placeholder="예: 채용, 가격" /></label>
              <label>확인 방식
                <select id="scheduleMode" aria-label="확인 방식"><option value="manual">수동</option><option value="interval">정기 확인</option></select>
              </label>
              <div id="intervalFields" class="interval-fields"><span>확인 간격</span>
                <div class="schedule">
                  <label><small>일</small><select id="days" aria-label="일"></select></label>
                  <label><small>시간</small><select id="hours" aria-label="시간"></select></label>
                </div>
              </div>
              <p class="notice" id="intervalSummary">자동 갱신 없이 수동으로만 확인합니다.</p>
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
      this.selectorTypeInput = this.shadow.querySelector('#selectorType');
      this.fieldTypeInput = this.shadow.querySelector('#fieldType');
      this.fieldNameInput = this.shadow.querySelector('#fieldName');
      this.fieldNameLabel = this.shadow.querySelector('#fieldNameLabel');
      this.nameInput = this.shadow.querySelector('#name');
      this.labelsInput = this.shadow.querySelector('#labels');
      this.scheduleModeInput = this.shadow.querySelector('#scheduleMode');
      this.intervalFields = this.shadow.querySelector('#intervalFields');
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
      this.scheduleModeInput.value = 'manual';
      this.updateFieldEditorVisibility();

      this.closeButton = this.shadow.querySelector('#close');
      this.cancelButton = this.shadow.querySelector('#cancel');
      this.selectAgainButton = this.shadow.querySelector('#selectAgain');
      this.closeButton.addEventListener('click', () => this.destroy());
      this.cancelButton.addEventListener('click', () => this.destroy());
      this.selectAgainButton.addEventListener('click', () => this.beginPicking());
      this.selectorInput.addEventListener('input', () => this.validateSelector());
      this.selectorTypeInput.addEventListener('change', () => {
        void this.changeActiveSelectorType(this.selectorTypeInput.value);
      });
      this.fieldTypeInput.addEventListener('change', () => {
        this.updateFieldEditorVisibility();
        this.validateSelector();
      });
      this.fieldNameInput.addEventListener('input', () => this.validateSelector());
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
      this.scheduleModeInput.addEventListener('change', () => this.updateInterval());
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
        ? '추가 선택 모드 · 포함한 영역 안을 다시 고르면 제외 규칙이 되고, 제외 안을 고르면 다시 포함합니다. Esc를 누르면 닫습니다.'
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
      const exposed = path.find((node) => node instanceof Element && node !== this.host && !this.host.contains(node)) ?? null;
      return exposed ? deepestShadowElementAtPoint(exposed, event.clientX, event.clientY) : null;
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
      void this.selectElement(element);
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

    updateFieldEditorVisibility() {
      const needsName = this.fieldTypeInput?.value !== 'text';
      this.fieldNameLabel.hidden = !needsName;
      this.fieldNameInput.disabled = !needsName;
    }

    fieldsFromEditor() {
      const type = this.fieldTypeInput?.value === 'attribute'
        ? 'attribute'
        : this.fieldTypeInput?.value === 'property' ? 'property' : 'text';
      if (type === 'text') return [{ type: 'text' }];
      const name = this.fieldNameInput.value.trim();
      return /^[A-Za-z_$][\w$-]{0,80}$/.test(name) ? [{ type, name }] : null;
    }

    syncFieldEditor(selection) {
      const fields = Array.isArray(selection?.fields) && selection.fields.length
        ? selection.fields
        : [{ type: 'text' }];
      const nonText = fields.find((field) => field?.type === 'attribute' || field?.type === 'property');
      const textOnly = fields.every((field) => field?.type === 'text');
      this.fieldTypeInput.value = textOnly ? 'text' : nonText?.type ?? 'text';
      this.fieldNameInput.value = textOnly ? '' : nonText?.name ?? '';
      this.updateFieldEditorVisibility();
    }

    selectedSelectorType() {
      return normalizedSelectorType(this.selectorTypeInput?.value);
    }

    syncSelectorEditor(selection) {
      this.selectorInput.value = selection?.selector ?? '';
      if (this.selectorTypeInput) {
        this.selectorTypeInput.value = normalizedSelectorType(selection?.selectorType);
      }
    }

    async changeActiveSelectorType(value) {
      const selection = this.currentSelection();
      if (!selection || this.saving) return;
      const nextType = normalizedSelectorType(value);
      const previousType = normalizedSelectorType(selection.selectorType);
      if (nextType === previousType) {
        this.validateSelector();
        return;
      }

      const target = selection.element ?? selection.matchedElements?.[0];
      const runtime = globalThis.__openStillSelectorX;
      let selector = '';
      try {
        if (nextType === 'xpath') {
          selector = await Promise.resolve(runtime?.getXPATH?.([target], { timeout: 500 }));
        } else if (nextType === 'xcss') {
          selector = await Promise.resolve(runtime?.getExtendedCSS?.([target], { timeout: 500 }));
        } else if (selectorTypeFor(target) !== 'xcss') {
          selector = await Promise.resolve(runtime?.getCSS?.([target], { timeout: 500 }));
          if (!selector) selector = selectorFor(target);
        }
      } catch {
        selector = '';
      }

      if (!selector) {
        this.selectorTypeInput.value = previousType;
        this.message.textContent = '현재 요소에는 선택한 타입으로 안정적인 선택자를 만들 수 없습니다.';
        return;
      }
      let matches = [];
      try {
        matches = queryTrackedElements(selector, document, nextType);
      } catch {
        // Keep the existing type and locator when the generated expression is
        // rejected by the browser's native selector/XPath evaluator.
      }
      if (!matches.length || (target && !matches.includes(target))) {
        this.selectorTypeInput.value = previousType;
        this.message.textContent = '변환한 선택자가 현재 요소와 일치하지 않습니다.';
        return;
      }
      selection.selectorType = nextType;
      selection.selector = selector;
      this.setSelectionMatchInfo(selection, matches);
      this.syncSelectorEditor(selection);
      this.validateSelector();
    }

    setSelectionMatchInfo(selection, matches, includedElements = matches) {
      const matchedElements = uniqueElementsInDocumentOrder(matches);
      const elements = uniqueElementsInDocumentOrder(includedElements);
      selection.matchedElements = matchedElements;
      selection.elements = elements;
      selection.element = elements[0] ?? matchedElements[0] ?? null;
      selection.totalMatchCount = matchedElements.length;
      selection.matchCount = elements.length;
      selection.text = snapshotTextForElements(elements);
    }

    renderSelectionList() {
      const includeCount = this.selections.filter((selection) => selection.op !== 'exclude').length;
      const excludeCount = this.selections.length - includeCount;
      this.selectionSummary.textContent = '선택한 요소 ' + includeCount + '개' + (excludeCount ? ' · 제외 ' + excludeCount + '개' : '');
      this.saveButton.textContent = includeCount > 1 ? includeCount + '개 추적 저장' : '추적 저장';
      this.selectionList.replaceChildren();

      this.selections.forEach((selection, index) => {
        const item = document.createElement('div');
        item.className = 'selection-item' + (index === this.activeSelectionIndex ? ' active' : '');
        const selectButton = document.createElement('button');
        selectButton.type = 'button';
        selectButton.dataset.selectionIndex = String(index);
        const css = document.createElement('span');
        css.className = 'selection-css';
        css.textContent = (selection.op === 'exclude' ? '[제외] ' : '') + selection.selector;
        const preview = document.createElement('span');
        preview.className = 'selection-text';
        preview.textContent = cleanText(selection.text, 130) || '(텍스트 없음)';
        selectButton.append(css, preview);
        const matchCount = selection.totalMatchCount ?? selection.matchCount ?? 0;
        preview.textContent = `${matchCount}개 일치 · ${cleanText(selection.text, 130) || '(텍스트 없음)'}`;
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
      this.syncSelectorEditor(selection);
      this.syncFieldEditor(selection);
      this.matchElements = selection.matchedElements?.length
        ? selection.matchedElements
        : selection.elements ?? (selection.element ? [selection.element] : []);
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
      this.syncSelectorEditor(selection);
      this.syncFieldEditor(selection);
      if (!this.nameInput.value) {
        this.nameInput.value = cleanText(document.title, 100)
          || selection.element?.localName?.toLowerCase() + ' 요소';
      }
      this.tooltip.hidden = true;
      this.renderSelectionList();
      this.updateInterval();
    }

    operationForElement(element) {
      const selectionsContaining = (op) => this.selections.some((selection) => (
        (selection.op === 'exclude' ? 'exclude' : 'include') === op
        && (selection.matchedElements ?? selection.elements ?? []).some((candidate) => composedContains(candidate, element))
      ));
      // Selecting inside an inclusion narrows it. Selecting inside that
      // exclusion explicitly opens a smaller inclusion again, so the user can
      // express include → exclude → include without losing the parent route.
      if (selectionsContaining('exclude')) return 'include';
      return selectionsContaining('include') ? 'exclude' : 'include';
    }

    async selectElement(element) {
      let selectorType = selectorTypeFor(element);
      let selector = selectorFor(element);
      // The reference picker degrades to an XPath locator when a semantic CSS
      // expression cannot be derived.  This preserves a selectable element
      // without silently falling back to a brittle full DOM path. XPath cannot
      // represent a shadow boundary, so retain XCSS for shadow-tree targets.
      if (!selector && selectorType !== 'xcss') {
        try {
          const xpath = await Promise.resolve(globalThis.__openStillSelectorX?.getXPATH?.([element], { timeout: 500 }));
          if (typeof xpath === 'string' && xpath && hasSingleMatch(xpath, element, 'xpath')) {
            selector = xpath;
            selectorType = 'xpath';
          }
        } catch {
          // Leave the regular selection error below when XPath generation
          // cannot establish a safe, unique expression either.
        }
      }
      if (!selector) {
        this.message.textContent = '이 요소는 표준 CSS 선택자로 안전하게 저장할 수 없습니다.';
        return;
      }
      let matches;
      try {
        matches = queryTrackedElements(selector, document, selectorType);
      } catch {
        this.message.textContent = '생성한 CSS 선택자를 검증하지 못했습니다.';
        return;
      }
      if (!matches.length || !matches.includes(element)) {
        this.message.textContent = '생성한 CSS 선택자가 선택한 요소를 포함하지 않습니다.';
        return;
      }

      const operation = this.operationForElement(element);
      const existingIndex = this.selections.findIndex((selection) => (
        selection.op === operation
        && (selection.selector === selector
          || selection.element === element
          || selection.matchedElements?.includes(element))
      ));
      if (existingIndex >= 0) {
        this.activeSelectionIndex = existingIndex;
        this.setSelectionMatchInfo(this.selections[existingIndex], matches);
      } else {
        if (this.selections.length >= MAX_SELECTIONS) {
          this.showEditor();
          this.message.textContent = '한 번에 선택할 수 있는 요소는 최대 ' + MAX_SELECTIONS + '개입니다.';
          return;
        }
        const selection = { selector, selectorType, op: operation, fields: [{ type: 'text' }] };
        this.setSelectionMatchInfo(selection, matches);
        this.selections.push(selection);
        this.activeSelectionIndex = this.selections.length - 1;
      }
      this.matchElements = matches;
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

      this.selections.forEach((selection, selectionIndex) => {
        const elements = selection.elements?.length
          ? selection.elements
          : selection.matchedElements ?? (selection.element ? [selection.element] : []);
        elements.forEach((element, elementIndex) => {
          if (drawn.size < MAX_HIGHLIGHTS) {
            draw(element, 'match selected' + (selection.op === 'exclude' ? ' excluded' : '') + (
              selectionIndex === this.activeSelectionIndex && elementIndex === 0 ? ' primary' : ''
            ));
          }
        });
      });
      this.matchElements.forEach((element, index) => {
        if (drawn.size < MAX_HIGHLIGHTS) {
          draw(element, 'match' + (index === 0 ? ' primary' : ''));
        }
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
      const scheduleMode = this.selectedScheduleMode();
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
      this.intervalFields.hidden = scheduleMode === 'manual';
      this.intervalSummary.textContent = scheduleMode === 'manual'
        ? '자동 갱신 없이 수동으로만 확인합니다. 대시보드의 “지금 확인”으로 갱신할 수 있습니다.'
        : totalHours >= 1 && totalHours <= 336
        ? `매 ${days ? `${days}일 ` : ''}${hours ? `${hours}시간` : ''}`.trim() + '마다 확인합니다.'
        : '간격은 최소 1시간, 최대 14일로 설정해 주세요.';
      this.validateSelector();
    }

    selectedScheduleMode() {
      return this.scheduleModeInput.value === 'interval' ? 'interval' : 'manual';
    }

    selectedIntervalHours() {
      return Number(this.daysInput.value) * 24 + Number(this.hoursInput.value);
    }

    validateSelector() {
      if (this.saving) {
        return false;
      }
      const selector = this.selectorInput.value.trim();
      const selectorType = this.selectedSelectorType();
      const totalHours = this.selectedIntervalHours();
      const scheduleMode = this.selectedScheduleMode();
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

      const fields = this.fieldsFromEditor();
      if (!fields) {
        this.validity.textContent = '속성 또는 프로퍼티를 추출하려면 유효한 이름을 입력해 주세요.';
        this.validity.classList.add('error');
        this.saveButton.disabled = true;
        return false;
      }

      try {
        const matches = queryTrackedElements(selector, document, selectorType);
        this.matchElements = matches;
        this.renderHighlights();
        if (!matches.length) {
          this.validity.textContent = '일치하는 요소가 없습니다. CSS 선택자를 확인해 주세요.';
          this.validity.classList.add('error');
          this.saveButton.disabled = true;
          return false;
        }

        active.selector = selector;
        active.selectorType = selectorType;
        active.fields = fields;
        this.setSelectionMatchInfo(active, matches);
        this.selectedElement = active.element;
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = active.text.slice(0, 700) || '(텍스트 없음)';
        const message = matches.length === 1
          ? '1개 요소와 일치합니다.'
          : `${matches.length}개 요소와 일치합니다. 모두 함께 추적합니다.`;
        this.validity.replaceChildren(document.createTextNode(message), preview);
        this.validity.classList.add('ok');
        this.renderSelectionList();
        this.saveButton.disabled = !((scheduleMode === 'manual' || (totalHours >= 1 && totalHours <= 336)) && this.selections.length);
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

      const activeSelection = this.currentSelection();
      const resolved = [];
      for (let index = 0; index < this.selections.length; index += 1) {
        const selection = this.selections[index];
        const selector = selection.selector.trim();
        if (!selector) {
          this.activeSelectionIndex = index;
          this.selectorInput.value = '';
          this.message.textContent = (index + 1) + '번째 CSS 선택자를 입력해 주세요.';
          this.renderSelectionList();
          return false;
        }
        try {
          const matches = uniqueElementsInDocumentOrder(queryTrackedElements(
            selector,
            document,
            normalizedSelectorType(selection.selectorType)
          ));
          if (!matches.length) {
            this.activeSelectionIndex = index;
            this.selectorInput.value = selector;
            this.message.textContent = (index + 1) + '번째 선택자와 일치하는 요소가 없습니다.';
            this.matchElements = [];
            this.renderHighlights();
            this.validity.textContent = '일치하는 요소가 없습니다. CSS 선택자를 확인해 주세요.';
            this.validity.className = 'validity error';
            this.saveButton.disabled = true;
            this.renderSelectionList();
            return false;
          }
          resolved.push({ selection, matches });
        } catch (error) {
          this.activeSelectionIndex = index;
          this.selectorInput.value = selector;
          this.message.textContent = (index + 1) + '번째 CSS 선택자가 유효하지 않습니다: ' + error.message;
          this.renderSelectionList();
          return false;
        }
      }

      // Reference-style grouped capture keeps a DOM node only once.  Resolve
      // the complete union first so an ancestor wins over its selected child,
      // then assign each remaining root to the first selector that contains it.
      const includes = resolved.filter(({ selection }) => selection.op !== 'exclude');
      if (!includes.length) {
        this.message.textContent = '최소 하나의 포함 선택이 필요합니다.';
        this.saveButton.disabled = true;
        return false;
      }
      // Preserve nested locators: an include inside an excluded branch is a
      // deliberate re-inclusion, not redundant selection noise.
      const previewRoots = removeNestedElements(includes.flatMap(({ matches }) => matches));
      for (const { selection, matches } of resolved) {
        const visibleMatches = selection.op === 'exclude'
          ? matches
          : matches.filter((element) => previewRoots.includes(element));
        this.setSelectionMatchInfo(selection, matches, visibleMatches.length ? visibleMatches : matches);
      }
      this.selections = resolved.map(({ selection }) => selection);
      if (!this.selections.length) {
        this.activeSelectionIndex = -1;
        this.message.textContent = '선택한 요소가 모두 다른 선택자에 포함됩니다. CSS 선택자를 다시 확인해 주세요.';
        this.saveButton.disabled = true;
        this.renderSelectionList();
        return false;
      }

      let activeIndex = this.selections.indexOf(activeSelection);
      if (activeIndex < 0) {
        activeIndex = Math.min(Math.max(this.activeSelectionIndex, 0), this.selections.length - 1);
      }
      this.activeSelectionIndex = activeIndex;
      const active = this.selections[activeIndex];
      this.selectedElement = active.element;
      this.syncSelectorEditor(active);
      this.syncFieldEditor(active);
      this.matchElements = active.matchedElements?.length ? active.matchedElements : active.elements;
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
      const scheduleMode = this.selectedScheduleMode();
      if (scheduleMode === 'interval' && (totalHours < 1 || totalHours > 336)) {
        this.message.textContent = '간격은 최소 1시간, 최대 14일입니다.';
        return;
      }

      this.saving = true;
      this.saveButton.disabled = true;
      this.closeButton.disabled = true;
      this.cancelButton.disabled = true;
      this.selectAgainButton.disabled = true;
      this.message.style.color = '#aebed2';
      this.message.textContent = this.selections.length + '개 선택 결과를 이 주소의 하나의 기준 목록으로 저장하는 중입니다…';

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'create-monitors',
          url: location.href,
          pageTitle: document.title,
          name: this.nameInput.value,
          labels: this.labelsInput.value.split(','),
          scheduleMode,
          intervalHours: totalHours,
          items: this.selections.map((selection) => ({
            type: selection.selectorType || 'css',
            expr: selection.selector,
            op: selection.op === 'exclude' ? 'exclude' : 'include',
            fields: Array.isArray(selection.fields) && selection.fields.length
              ? selection.fields
              : [{ type: 'text' }]
          }))
        });
        if (!response?.ok) {
          throw new Error(response?.error || '저장에 실패했습니다.');
        }
        this.saved = true;
        this.saving = false;
        this.message.style.color = '#77edbd';
        const selectorCount = response.monitor?.selectors?.length ?? this.selections.length;
        this.message.textContent = `${selectorCount}개 선택자를 이 주소의 하나의 추적에 저장했습니다.${scheduleMode === 'manual' ? ' 자동 갱신 없이 대시보드의 “지금 확인”으로 기준값과 변경을 확인할 수 있습니다.' : ' 다음 확인에서 기준 목록을 만든 뒤 이후 변경을 알려드릴게요.'}`;
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
