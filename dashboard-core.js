/* Shared, DOM-free dashboard algorithms. Work is bounded by the visible list
 * or exact identity maps before any similarity comparison is attempted. */
(function (root) {
  'use strict';
  function digest(value) {
    const text = String(value ?? '');
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489917);
    }
    return `${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
  }

  function identity(node) {
    const explicit = node?.identity?.key ?? node?.identityKey;
    const frame = node?.frame;
    const volatileParameters = new Set([...(node?.locator?.frameVolatileParameters ?? []), ...(node?.locators ?? []).flatMap((locator) => locator.frameVolatileParameters ?? [])]);
    const stableUrl = (value) => {
      if (!volatileParameters.size) return value ?? '';
      try { const url = new URL(value); for (const parameter of volatileParameters) url.searchParams.delete(parameter); return url.href; } catch { return value ?? ''; }
    };
    const frameScope = frame ? JSON.stringify([stableUrl(frame.url), (frame.path ?? []).map((part) => [stableUrl(part.url), part.element?.attribute ?? '', part.element?.value ?? ''])]) : '';
    if (explicit) return `identity:${frameScope}:${explicit}`;
    const attributes = node?.attributes ?? {};
    for (const key of ['data-post-id', 'data-item-id', 'data-id', 'id']) {
      if (attributes[key]) return `${frameScope}:${node.type}:${node.tagName || ''}:${key}:${attributes[key]}`;
    }
    if (attributes.href) return `permalink:${frameScope}:${attributes.href}`;
    const links = [];
    const visit = (item) => {
      if (item?.tagName === 'a' && item.attributes?.href) links.push(item.attributes.href);
      for (const child of item?.children ?? []) visit(child);
    };
    visit(node);
    return links.length === 1 ? `permalink:${frameScope}:${links[0]}` : '';
  }

  function fingerprint(node) {
    if (!node) return '';
    if (node.fingerprint !== undefined) return node.fingerprint;
    const attributes = Object.entries(node.attributes ?? {}).sort(([left], [right]) => left.localeCompare(right));
    node.fingerprint = digest(JSON.stringify([
      node.type, node.tagName ?? '', node.language ?? '', node.resource ?? '',
      node.text ?? '', attributes, (node.children ?? []).map(fingerprint),
      node.itemSnapshot ? [node.itemSnapshot.text ?? '', node.itemSnapshot.html ?? '', node.itemSnapshot.data ?? ''] : null
    ]));
    return node.fingerprint;
  }

  function align(before, after, similarity = () => 0, maxCells = 12000) {
    const paired = new Map();
    const used = new Set();
    const match = (keyOf, accepts = () => true) => {
      const positions = new Map();
      before.forEach((node, index) => {
        if (used.has(index)) return;
        const key = keyOf(node);
        if (!key) return;
        let bucket = positions.get(key);
        if (!bucket) positions.set(key, bucket = { values: [], next: 0 });
        bucket.values.push(index);
      });
      after.forEach((node, index) => {
        if (paired.has(index)) return;
        const bucket = positions.get(keyOf(node));
        if (!bucket) return;
        while (bucket.next < bucket.values.length) {
          const candidate = bucket.values[bucket.next++];
          if (!accepts(before[candidate], node)) continue;
          used.add(candidate);
          paired.set(index, candidate);
          break;
        }
      });
    };
    match(identity);
    match(fingerprint, (left, right) => !identity(left) || !identity(right) || identity(left) === identity(right));
    const oldResidual = before.map((node, index) => ({ node, index })).filter((item) => !used.has(item.index) && !identity(item.node));
    const newResidual = after.map((node, index) => ({ node, index })).filter((item) => !paired.has(item.index) && !identity(item.node));
    if (before.length === 1 && after.length === 1 && oldResidual.length * newResidual.length <= maxCells) {
      // Exact matches were reserved globally, including reordered items. Weak
      // matches may never steal the identities or content anchors above.
      const matrix = Array.from({ length: oldResidual.length + 1 }, () => new Float32Array(newResidual.length + 1));
      for (let oldIndex = oldResidual.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newResidual.length - 1; newIndex >= 0; newIndex -= 1) {
          const score = similarity(oldResidual[oldIndex].node, newResidual[newIndex].node);
          matrix[oldIndex][newIndex] = Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1], score > 0 ? score + matrix[oldIndex + 1][newIndex + 1] : 0);
        }
      }
      let oldIndex = 0;
      let newIndex = 0;
      while (oldIndex < oldResidual.length && newIndex < newResidual.length) {
        const score = similarity(oldResidual[oldIndex].node, newResidual[newIndex].node);
        if (score > 0 && score + matrix[oldIndex + 1][newIndex + 1] >= Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1])) {
          paired.set(newResidual[newIndex].index, oldResidual[oldIndex].index);
          used.add(oldResidual[oldIndex].index);
          oldIndex += 1;
          newIndex += 1;
        } else if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) oldIndex += 1;
        else newIndex += 1;
      }
    }
    const matchedPairs = [...paired.entries()].sort(([left], [right]) => left - right);
    const stable = new Set(longestIncreasingPairs(matchedPairs.map(([afterIndex, beforeIndex]) => [beforeIndex, afterIndex])).map(([, afterIndex]) => afterIndex));
    const operations = before.map((node, index) => used.has(index) ? null : { type: 'removed', before: node }).filter(Boolean);
    after.forEach((node, index) => {
      const oldIndex = paired.get(index);
      operations.push(oldIndex === undefined ? { type: 'added', after: node } : {
        type: 'pair', before: before[oldIndex], after: node, moved: !stable.has(index),
        beforeIndex: oldIndex, afterIndex: index
      });
    });
    return operations;
  }

  function longestIncreasingPairs(pairs) {
    const tails = [];
    const previous = new Int32Array(pairs.length).fill(-1);
    pairs.forEach((pair, index) => {
      let low = 0;
      let high = tails.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pairs[tails[middle]][0] < pair[0]) low = middle + 1;
        else high = middle;
      }
      if (low) previous[index] = tails[low - 1];
      tails[low] = index;
    });
    const result = [];
    for (let index = tails[tails.length - 1]; index !== undefined && index >= 0; index = previous[index]) result.push(pairs[index]);
    return result.reverse();
  }

  function diff(before, after, maxCells = 60000) {
    const operations = [];
    const add = (type, values) => values.forEach((value) => operations.push({ type, value }));
    const compare = (oldValues, newValues, depth = 0) => {
      let prefix = 0;
      while (prefix < oldValues.length && prefix < newValues.length && oldValues[prefix] === newValues[prefix]) {
        operations.push({ type: 'same', value: oldValues[prefix++] });
      }
      let oldEnd = oldValues.length;
      let newEnd = newValues.length;
      while (oldEnd > prefix && newEnd > prefix && oldValues[oldEnd - 1] === newValues[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
      const left = oldValues.slice(prefix, oldEnd);
      const right = newValues.slice(prefix, newEnd);
      if (!left.length) add('added', right);
      else if (!right.length) add('removed', left);
      else if (left.length * right.length <= maxCells) {
        const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
        for (let oldIndex = left.length - 1; oldIndex >= 0; oldIndex -= 1) {
          for (let newIndex = right.length - 1; newIndex >= 0; newIndex -= 1) matrix[oldIndex][newIndex] = left[oldIndex] === right[newIndex] ? matrix[oldIndex + 1][newIndex + 1] + 1 : Math.max(matrix[oldIndex + 1][newIndex], matrix[oldIndex][newIndex + 1]);
        }
        let oldIndex = 0;
        let newIndex = 0;
        while (oldIndex < left.length && newIndex < right.length) {
          if (left[oldIndex] === right[newIndex]) { operations.push({ type: 'same', value: left[oldIndex++] }); newIndex += 1; }
          else if (matrix[oldIndex + 1][newIndex] >= matrix[oldIndex][newIndex + 1]) operations.push({ type: 'removed', value: left[oldIndex++] });
          else operations.push({ type: 'added', value: right[newIndex++] });
        }
        add('removed', left.slice(oldIndex));
        add('added', right.slice(newIndex));
      } else {
        const buckets = new Map();
        left.forEach((value, index) => {
          let bucket = buckets.get(value);
          if (!bucket) buckets.set(value, bucket = { positions: [], next: 0 });
          bucket.positions.push(index);
        });
        const pairs = [];
        right.forEach((value, index) => {
          const bucket = buckets.get(value);
          if (bucket && bucket.next < bucket.positions.length) pairs.push([bucket.positions[bucket.next++], index]);
        });
        const anchors = depth < 24 ? longestIncreasingPairs(pairs) : [];
        if (!anchors.length) { add('removed', left); add('added', right); }
        else {
          let oldStart = 0;
          let newStart = 0;
          for (const [oldIndex, newIndex] of anchors) {
            compare(left.slice(oldStart, oldIndex), right.slice(newStart, newIndex), depth + 1);
            operations.push({ type: 'same', value: left[oldIndex] });
            oldStart = oldIndex + 1;
            newStart = newIndex + 1;
          }
          compare(left.slice(oldStart), right.slice(newStart), depth + 1);
        }
      }
      add('same', oldValues.slice(oldEnd));
    };
    compare(before, after);
    return operations;
  }

  function viewport(total, scrollTop, height, rowHeight = 48, overscan = 8) {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + overscan);
    return { start: Math.min(start, total), end, top: Math.min(start, total) * rowHeight, bottom: Math.max(0, total - end) * rowHeight };
  }

  function parseLocators(value) {
    const locators = [];
    const errors = [];
    const validField = (field) => {
      let type;
      let name;
      if (typeof field === 'string') {
        if (field === 'text') return true;
        type = field.startsWith('property:') ? 'property' : 'attribute';
        name = field.startsWith('property:') ? field.slice(9) : field.startsWith('attr:') ? field.slice(5) : field;
      } else if (field && typeof field === 'object' && !Array.isArray(field)) {
        type = String(field.type ?? field.kind ?? '').toLowerCase();
        name = String(field.name ?? field.value ?? '').trim();
        if (type === 'builtin' && name === 'text') type = 'text';
      } else return false;
      name = String(name ?? '').trim();
      if (type === 'text') return true;
      return ['attribute', 'property'].includes(type) && Boolean(name) && name.length <= 256 && !/[\u0000-\u001F\u007F\s]/.test(name) && (type !== 'attribute' || !/["'<>\/=]/.test(name));
    };
    String(value ?? '').split(/\r?\n/).forEach((line, index) => {
      const source = line.trim();
      if (!source) return;
      try {
        let locator;
        if (source.startsWith('{') || source.startsWith('[')) locator = JSON.parse(source);
        else {
          const match = source.match(/^(?:(exclude)\s+)?(css|xcss|xpath)\s*:\s*(.+)$/i);
          locator = match ? { type: match[2].toLowerCase(), expr: match[3].trim(), op: match[1] ? 'exclude' : 'include' } : { type: 'css', expr: source, op: 'include' };
        }
        if (!locator || typeof locator !== 'object' || Array.isArray(locator)
          || !['css', 'xcss', 'xpath'].includes(String(locator.type ?? 'css').toLowerCase())
          || !String(locator.expr ?? locator.selector ?? locator.value ?? '').trim()
          || String(locator.expr ?? locator.selector ?? locator.value ?? '').length > 2000
          || (locator.op && !['include', 'exclude'].includes(locator.op))
          || (locator.fields != null && (Array.isArray(locator.fields) ? locator.fields.length > 256 || locator.fields.some((field) => !validField(field)) : !validField(locator.fields)))) throw new Error('선택자 형식·표현식·필드를 확인하세요.');
        locators.push(locator);
      } catch (error) { errors.push({ line: index + 1, source, error: error.message }); }
    });
    return { locators, errors };
  }

  function resultSummary(response, requested = 0) {
    const completed = Math.max(0, Number(response?.completed ?? response?.updated ?? response?.deletedCount) || 0);
    const skipped = Math.max(0, Number(response?.skipped) || 0);
    const failed = Math.max(0, Number(response?.failed ?? response?.failedIds?.length) || 0);
    const paused = Math.max(0, Number(response?.paused) || 0);
    const missing = Math.max(0, Number(response?.missing ?? response?.missingIds?.length) || 0);
    const conflict = Math.max(0, Number(response?.conflict ?? response?.conflictIds?.length) || 0);
    // Servers can return conflict IDs in unprocessedIds as well. Display
    // disjoint outcomes so one conflict never inflates the requested total.
    const classifiedIds = new Set(['completedIds', 'processedIds', 'deletedIds', 'failedIds', 'pausedIds', 'missingIds', 'conflictIds'].flatMap((key) => response?.[key] ?? []));
    const unclassified = (response?.unprocessedIds ?? []).filter((id) => !classifiedIds.has(id)).length;
    const unprocessed = requested > 0 ? Math.max(requested - completed - skipped - failed - paused - missing - conflict, 0) : unclassified;
    return { completed, skipped, failed, paused, missing, conflict, unprocessed };
  }
  const api = { digest, identity, fingerprint, align, diff, viewport, parseLocators, resultSummary };
  root.OpenStillDashboardCore = api;
  if (typeof module === 'object') module.exports = api;
})(globalThis);
