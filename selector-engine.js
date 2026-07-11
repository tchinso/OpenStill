(() => {
  'use strict';

  // A synchronous, ordinary-DOM port of SelectorX from
  // References/ui/assets/HollowCircle-CvrxAR1C.js.  Keep the implementation
  // intentionally close to the reference: its greedy token ordering and
  // shake pass are what turn brittle full DOM paths into resilient selectors.

  const MAX_NAME_LENGTH = 20;
  const MAX_VALUE_LENGTH = 30;
  const MAX_ATTRIBS = 15;
  const MAX_PARTIAL_COUNT = 10;

  function toMean(cumulative, current, index) {
    return cumulative + (current - cumulative) / (index + 1);
  }

  function toMin(cumulative, current) {
    return current > cumulative ? cumulative : current;
  }

  function getWordArr(word) {
    word = word.replace(/(.+)([A-Z][a-z])/g, '$1 $2');
    word = word.replace(/([a-z])([A-Z])/, '$1 $2');
    return word.split(/[\s\,_\-\(\)\[\]\=]+/);
  }

  function getMultiWordArr(value) {
    const regexp = /^[a-zA-Z0-9]+[\-_\s]{1,2}[a-zA-Z0-9]+/;
    const regexp2 = /^[a-zA-Z0-9]+[\-_\s]{1,2}[a-zA-Z0-9]+[\-_\s]{1,2}[a-zA-Z-0-9]+/;
    const regexp3 = /\b[a-z]+[A-Z][a-z]{2,}/g;
    return [...(value.match(regexp) || [])]
      .concat([...(value.match(regexp2) || [])])
      .concat([...value.matchAll(regexp3)].map((match) => match[0]));
  }

  function getPartialTokenValues(word, options) {
    let words = [];
    if (!/([a-z][A-Z])|[\-_\s]/.test(word)) {
      return words;
    }
    if (options && options.multi && word.length > 3) {
      words = words.concat(getMultiWordArr(word));
    }
    words = words.concat(getWordArr(word));
    words = words.filter((value) => value.length > 3);
    return words.slice(0, (options && options.maxCount) || MAX_PARTIAL_COUNT);
  }

  class XSet extends Set {
    get length() {
      return this.size;
    }

    get first() {
      for (const item of this) {
        return item;
      }
      return undefined;
    }

    map(mapMethod) {
      return [...this].map(mapMethod);
    }

    mapToSet(mapMethod) {
      return new XSet(this.map(mapMethod));
    }

    filter(filterMethod) {
      return new XSet([...this].filter(filterMethod));
    }

    isSubsetOf(anotherSet) {
      return [...this].every((item) => anotherSet.has(item));
    }

    isEqualTo(anotherSet) {
      return this.isSubsetOf(anotherSet) && anotherSet.isSubsetOf(this);
    }

    difference(anotherSet) {
      const values = [];
      for (const item of this) {
        if (!anotherSet.has(item)) {
          values.push(item);
        }
      }
      return new XSet(values);
    }

    clone() {
      return new XSet([...this]);
    }

    toArray() {
      return [...this];
    }
  }

  const penalWords = ['false', 'true', 'blank'];
  const stylingWords = [
    'css', 'align', 'animation', 'delay', 'direction', 'fill', 'mode', 'iteration', 'name', '@keyframes',
    'state', 'timing', 'function', 'backface', 'visibility', 'background', 'attachment', 'clip', 'image',
    'origin', 'position', 'repeat', 'size', 'border', 'bottom', 'radius', 'right', 'style', 'width',
    'collapse', 'collapsed', 'outset', 'slice', 'source', 'spacing', 'top', 'box', 'shadow', 'sizing',
    'caption', 'side', 'clear', 'column', 'gap', 'rule', 'span', 'columns', 'counter', 'increment',
    'reset', 'cursor', 'display', 'empty', 'cell', 'flex', 'basis', 'flow', 'wrap', 'grow', 'shrink',
    'float', 'font', 'family', 'adjust', 'stretch', 'variant', 'weight', 'height', 'justify', 'letter',
    'line', 'margin', 'max', 'min', 'opacity', 'order', 'outline', 'offset', 'overflow', 'padding',
    'break', 'after', 'before', 'inside', 'perspective', 'quotes', 'resize', 'tab', 'layout', 'decoration',
    'indent', 'transform', 'transition', 'property', 'vertical', 'white', 'space', 'word', 'index', 'foramt',
    'row', 'col', 'format', 'highlight', 'vert', 'middle', 'large', 'down', 'small', 'overlay', 'trigger'
  ];
  const cssColorWords = [
    'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
    'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral',
    'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
    'darkgrey', 'darkgreen', 'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid',
    'darkred', 'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
    'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
    'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod',
    'gray', 'grey', 'green', 'greenyellow', 'honeydew', 'hotpink', 'indianred ', 'indigo ', 'ivory', 'khaki',
    'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
    'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen', 'lightpink', 'lightsalmon',
    'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow',
    'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid',
    'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise',
    'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
    'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise',
    'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
    'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
    'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
    'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke',
    'yellow', 'yellowgreen'
  ];
  const cssPositionWords = ['top', 'left', 'right', 'bottom', 'position'];
  const cssLayoutWords = ['flex', 'grid', 'col', 'row', 'inline'];
  const fontWords = ['xs', 'sm', 'lg', 'md', 'semibold', 'bold', 'medium', 'large', 'small'];
  const metaWords = ['lang'];
  const cssWords = penalWords.concat(stylingWords, cssColorWords, cssPositionWords, cssLayoutWords, fontWords, metaWords);

  // cssesc v3.0.0, Copyright Mathias Bynens, MIT License.
  // Full notice: THIRD_PARTY_NOTICES.md.  Its escaping behavior matches the
  // bundled reference implementation.
  const cssescObject = {};
  const cssescHasOwnProperty = cssescObject.hasOwnProperty;
  const cssescMerge = (options, defaults) => {
    if (!options) {
      return defaults;
    }
    const result = {};
    for (const key in defaults) {
      result[key] = cssescHasOwnProperty.call(options, key) ? options[key] : defaults[key];
    }
    return result;
  };
  const regexAnySingleEscape = /[ -,\.\/:-@\[-\^`\{-~]/;
  const regexSingleEscape = /[ -,\.\/:-@\[\]\^`\{-~]/;
  const regexExcessiveSpaces = /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g;

  function cssesc(string, options) {
    options = cssescMerge(options, cssesc.options);
    if (options.quotes !== 'single' && options.quotes !== 'double') {
      options.quotes = 'single';
    }
    const quote = options.quotes === 'double' ? '"' : "'";
    const isIdentifier = options.isIdentifier;
    const firstChar = string.charAt(0);
    let output = '';
    let counter = 0;
    const length = string.length;
    while (counter < length) {
      const character = string.charAt(counter++);
      let codePoint = character.charCodeAt();
      let value;
      if (codePoint < 32 || codePoint > 126) {
        if (codePoint >= 55296 && codePoint <= 56319 && counter < length) {
          const extra = string.charCodeAt(counter++);
          if ((extra & 64512) === 56320) {
            codePoint = ((codePoint & 1023) << 10) + (extra & 1023) + 65536;
          } else {
            counter--;
          }
        }
        value = `\\${codePoint.toString(16).toUpperCase()} `;
      } else if (options.escapeEverything) {
        if (regexAnySingleEscape.test(character)) {
          value = `\\${character}`;
        } else {
          value = `\\${codePoint.toString(16).toUpperCase()} `;
        }
      } else if (/[\t\n\f\r\x0B]/.test(character)) {
        value = `\\${codePoint.toString(16).toUpperCase()} `;
      } else if (
        character === '\\'
        || (!isIdentifier && (character === '"' && quote === character || character === "'" && quote === character))
        || (isIdentifier && regexSingleEscape.test(character))
      ) {
        value = `\\${character}`;
      } else {
        value = character;
      }
      output += value;
    }
    if (isIdentifier) {
      if (/^-[-\d]/.test(output)) {
        output = `\\-${output.slice(1)}`;
      } else if (/\d/.test(firstChar)) {
        output = `\\3${firstChar} ${output.slice(1)}`;
      }
    }
    output = output.replace(regexExcessiveSpaces, ($0, $1, $2) => {
      if ($1 && $1.length % 2) {
        return $0;
      }
      return ($1 || '') + $2;
    });
    if (!isIdentifier && options.wrap) {
      return quote + output + quote;
    }
    return output;
  }
  cssesc.options = {
    escapeEverything: false,
    isIdentifier: false,
    quotes: 'single',
    wrap: false
  };

  function getNthIndex(node) {
    const parent = node.parentElement;
    if (parent) {
      return Array.from(parent.children).indexOf(node) + 1;
    }
    throw new Error('no parent');
  }

  function buildCSSQuery(tree) {
    tree = tree.clone();
    removeDanglingCSSTokens(tree);
    if (tree.tokens.length === 0) {
      return '*';
    }
    let path = '';
    const tokens = tree.tokens;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const tokenString = formatCSSToken(token, token.nodeRef);
      path += addCSSConnector(tokens[index - 1], token, path) + tokenString;
    }
    if (tokens[tokens.length - 1].offset !== 0) {
      path += '~ *';
    }
    if (tokens[tokens.length - 1].depth !== tree.maxDepth) {
      path += ' *';
    }
    return path;
  }

  function addCSSConnector(previousToken, currentToken, path) {
    if (path === '') {
      return '';
    }
    if (previousToken.depth === currentToken.depth && previousToken.offset === currentToken.offset) {
      return '';
    }
    if (
      previousToken.offset === 0
      && currentToken.depth - previousToken.depth === 1
      && previousToken.type === 'immediate'
      && currentToken.type !== 'immediate'
    ) {
      return '> ';
    }
    if (previousToken.offset === 0 && previousToken.depth !== currentToken.depth) {
      return ' ';
    }
    if (
      previousToken.offset - currentToken.offset === 1
      && previousToken.depth === currentToken.depth
      && previousToken.type === 'immediate'
    ) {
      return '+ ';
    }
    if (previousToken.offset < currentToken.offset && previousToken.depth === currentToken.depth) {
      return '~ ';
    }
    if (previousToken.offset !== 0 && previousToken.depth !== currentToken.depth) {
      return '~ * ';
    }
    throw new Error(`unmatched condition in add Connector. prevdepth ${previousToken.depth}, prevOffset ${previousToken.offset}, curDept ${currentToken.depth}, curOffset ${currentToken.offset}`);
  }

  function formatCSSToken(token, currentNode) {
    if (token.type.startsWith('attrib') && (token.name.includes(':') || token.name === 'xmlns')) {
      throw new Error('got xmlns token');
    }
    if (token.type === 'pos') {
      const index = getNthIndex(currentNode);
      return index === 1 ? ':first-child' : `:nth-child(${index})`;
    }
    if (token.type === 'tag') {
      return cssesc(token.name, { isIdentifier: true });
    }
    if (token.type === 'attrib' && token.name === 'class') {
      if (!/[^a-zA-Z0-9_\-]/.test(token.value) && currentNode.classList.contains(token.value)) {
        return `.${cssesc(token.value, { isIdentifier: true })}`;
      }
      return `[${cssesc(token.name, { isIdentifier: true })}*='${cssesc(token.value, { isIdentifier: true })}']`;
    }
    if (token.type === 'attrib' && token.name === 'id') {
      return `#${cssesc(token.value, { isIdentifier: true })}`;
    }
    if (token.type === 'attrib') {
      return `[${cssesc(token.name, { isIdentifier: true })}='${cssesc(token.value, { isIdentifier: true })}']`;
    }
    if (token.type === 'attribStart') {
      return `[${cssesc(token.name, { isIdentifier: true })}^='${cssesc(token.value, { isIdentifier: true })}']`;
    }
    if (token.type === 'attribEnd') {
      return `[${cssesc(token.name, { isIdentifier: true })}$='${cssesc(token.value, { isIdentifier: true })}']`;
    }
    if (token.type === 'attribContain') {
      return `[${cssesc(token.name, { isIdentifier: true })}*='${cssesc(token.value, { isIdentifier: true })}']`;
    }
    if (token.type === 'attribOnly') {
      return `[${cssesc(token.name, { isIdentifier: true })}]`;
    }
    if (token.type === 'immediate') {
      return '';
    }
    throw new Error(`the type ${token.type} is unhandled`);
  }

  function removeDanglingCSSTokens(tree) {
    const danglingPositions = [];
    for (let index = 0; index < tree.tokens.length; index++) {
      if (tree.tokens[index].type !== 'pos') {
        continue;
      }
      let badPosition = true;
      for (let cursor = index - 1; cursor >= 0; cursor--) {
        if (
          tree.tokens[cursor].depth !== tree.tokens[index].depth
          || tree.tokens[cursor].offset !== tree.tokens[index].offset
        ) {
          break;
        }
        if (tree.tokens[cursor].type === 'tag') {
          badPosition = false;
          break;
        }
      }
      if (badPosition) {
        danglingPositions.push(tree.tokens[index]);
      }
    }
    for (const token of danglingPositions) {
      tree.removeToken(token);
    }

    const danglingImmediate = [];
    for (let index = 0; index < tree.tokens.length; index++) {
      if (tree.tokens[index].type !== 'immediate') {
        continue;
      }
      if (
        index === 0
        || index === tree.tokens.length - 1
        || tree.tokens[index].depth !== tree.tokens[index - 1].depth
        || tree.tokens[index].offset !== tree.tokens[index - 1].offset
        || !(
          tree.tokens[index + 1].depth - tree.tokens[index].depth === 1
          || (
            tree.tokens[index + 1].depth === tree.tokens[index].depth
            && tree.tokens[index + 1].offset - tree.tokens[index].offset === 1
          )
        )
      ) {
        danglingImmediate.push(tree.tokens[index]);
      }
    }
    for (const token of danglingImmediate) {
      tree.removeToken(token);
    }
  }

  const excludeTags = ['script', 'style', 'link', 'head', 'noscript', 'object', 'meta'];
  const excludeAttribs = [
    'srcdoc', 'style', 'onafterprint', 'onbeforeprint', 'onbeforeunload', 'onerror', 'onhaschange', 'onload',
    'onmessage', 'onoffline', 'onpagehide', 'onpageshow', 'onpopstate', 'onredo', 'onresize', 'onstorage',
    'onundo', 'onunload', 'onblur', 'onchange', 'oncontextmenu', 'onfocus', 'onformchange', 'onforminput',
    'oninput', 'oninvalid', 'onreset', 'onselect', 'onsubmit', 'onkeydown', 'onkeypress', 'onkeyup', 'onclick',
    'ondblclick', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave', 'ondragover', 'ondragstart', 'ondrop',
    'onmousedown', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup', 'onmousewheel', 'onscroll',
    'onabort', 'oncanplay', 'oncanplaythrough', 'ondurationchange', 'onemptied', 'onended', 'onerror',
    'onloadeddata', 'onloadedmetadata', 'onloadstart', 'onpause', 'onplay', 'onplaying', 'onprogress',
    'onratechange', 'onreadystatechange', 'onseeked', 'onseeking', 'onstalled', 'onsuspend', 'ontimeupdate',
    'onvolumechange', 'onwaiting'
  ];
  const priorityNames1 = ['a', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'title'];
  const priorityNames2 = ['td', 'tr', 'table', 'ul', 'ol', 'header', 'footer', 'img', 'label', 'section'];
  const priorityPos = ['td', 'tr', 'li', 'a'];
  const priorityValues1 = ['result', 'upvote', 'downvote', 'price', 'product', 'rating', 'rated'];
  const priorityValues2 = ['feature', 'vote', 'heading', 'rate'];

  class SelectorNode {
    constructor(targetNode, root, tokens, maxDepth) {
      this.targetNode = targetNode;
      this._root = root;
      this._tokens = [...tokens];
      this.maxDepth = maxDepth;
    }

    static addNewToken(type, name, value, depth, offset, nodeRef, tokens, filterCallback) {
      if (
        ['attrib', 'attribContain', 'attribStart', 'attribEnd', 'text'].includes(type)
        && value
        && (!Token.isNotRandGen(value) || Token.isUUID(value))
      ) {
        return;
      }
      if (typeof filterCallback === 'undefined' || filterCallback(type, name, value, depth, offset)) {
        const token = Token.createNew(type, name, value, depth, offset, nodeRef);
        // This mirrors the reference's identity check (rather than semantic
        // de-duplication), so repeated token sources retain their tie order.
        if (!tokens.includes(token)) {
          tokens.unshift(token);
        }
      }
    }

    static addTextTokens(depth, offset, nodeRef, tokens, coveredNodes, unsatisfied, filterCallback) {
      let text = this.getTextArrFromNode(nodeRef, coveredNodes, unsatisfied);
      text = text.filter((value) => !value.includes("'") && value.length > 3);
      for (const value of text) {
        this.addNewToken('text', 'text', value, depth, offset, nodeRef, tokens, filterCallback);
      }
    }

    static addPartialTokens(name, value, words, depth, offset, nodeRef, onlyContains, tokens, filterCallback) {
      if (Token.isUUID(value)) {
        return;
      }
      for (const word of words) {
        let type = 'attribContain';
        if (!onlyContains) {
          if (value.indexOf(word) === 0) {
            type = 'attribStart';
          } else if (value.indexOf(word) === value.length - word.length) {
            type = 'attribEnd';
          }
        }
        this.addNewToken(type, name, word, depth, offset, nodeRef, tokens, filterCallback);
      }
    }

    static buildTree(targetNode, root, options, unsatisfied, filterCallback) {
      // getMaxDepth walks down from root.  Checking containment before that
      // walk is essential: an unrelated (or stale) root otherwise has no
      // child to advance to and would spin forever on the page thread.
      if (
        !targetNode
        || targetNode.nodeType !== 1
        || !root
        || typeof root.contains !== 'function'
        || !root.contains(targetNode)
      ) {
        throw new Error('target is not in subtree');
      }
      const coveredNodes = [];
      const tokens = [];
      const maxDepth = this.getMaxDepth(targetNode, root);
      let depth = maxDepth;
      let currentNode = targetNode;
      while (currentNode && root.contains(currentNode)) {
        this.generateTokens(currentNode, options, depth, 0, tokens, coveredNodes, unsatisfied, filterCallback);
        if (options.siblingNodes) {
          const leftSibling = getLeftSibling(currentNode);
          if (leftSibling) {
            this.generateTokens(leftSibling.node, options, depth, -1, tokens, coveredNodes, unsatisfied, filterCallback);
            const secondLeftSibling = getLeftSibling(leftSibling.node);
            if (secondLeftSibling) {
              this.generateTokens(secondLeftSibling.node, options, depth, -2, tokens, coveredNodes, unsatisfied, filterCallback);
            }
          }
        }
        depth -= 1;
        if (currentNode.parentNode) {
          currentNode = currentNode.parentNode;
        }
        if (currentNode && currentNode.constructor.name === 'ShadowRoot') {
          break;
        }
      }
      return new SelectorNode(targetNode, root, tokens, maxDepth);
    }

    static generateTokens(nodeRef, options, depth, offset, tokens, coveredNodes, unsatisfied, filterCallback) {
      const element = nodeRef;
      this.addNewToken('immediate', null, null, depth, offset, nodeRef, tokens, filterCallback);
      if (element.parentElement) {
        this.addNewToken('pos', element.tagName.toLowerCase(), getNthIndex(nodeRef).toString(), depth, offset, nodeRef, tokens, filterCallback);
      }
      if (options.text) {
        this.addTextTokens(depth, offset, nodeRef, tokens, coveredNodes, unsatisfied, filterCallback);
      }
      const attributes = Array.from(element.attributes).slice(0, MAX_ATTRIBS);
      const classList = element.classList && element.classList.length > 0
        ? Array.from(element.classList).slice(0, MAX_ATTRIBS)
        : [];
      for (const { name, value } of attributes) {
        if (name.length > MAX_NAME_LENGTH || name.includes(':') || name.indexOf('xmlns') >= 0 || excludeAttribs.includes(name)) {
          continue;
        }
        if (value.trim().length > 0) {
          if (name === 'class') {
            classList.forEach((className) => this.addNewToken('attrib', name, className, depth, offset, nodeRef, tokens, filterCallback));
          } else if (value.length <= MAX_VALUE_LENGTH) {
            this.addNewToken('attrib', name, value, depth, offset, nodeRef, tokens, filterCallback);
          }
        }
        if (name !== 'id' && name !== 'class') {
          this.addNewToken('attribOnly', name, null, depth, offset, nodeRef, tokens, filterCallback);
        }
      }
      if (options.partAttrib) {
        for (const className of classList) {
          let words = getPartialTokenValues(className, { multi: true });
          words = [...new Set(words)];
          this.addPartialTokens('class', className, words, depth, offset, nodeRef, true, tokens, filterCallback);
        }
        for (const { name, value } of attributes) {
          if (name === 'class') {
            continue;
          }
          if (name.length > MAX_NAME_LENGTH || name.includes(':') || name.indexOf('xmlns') >= 0 || excludeAttribs.includes(name)) {
            continue;
          }
          if (value.trim().length > 0) {
            let words = getPartialTokenValues(value, { multi: true });
            words = [...new Set(words)];
            this.addPartialTokens(name, value, words, depth, offset, nodeRef, false, tokens, filterCallback);
          }
        }
      }
      this.addNewToken('tag', element.tagName.toLowerCase(), null, depth, offset, nodeRef, tokens, filterCallback);
    }

    static getMaxDepth(targetNode, root) {
      let depth = 0;
      let currentNode = root;
      while (currentNode !== targetNode) {
        depth += 1;
        let nextNode = null;
        for (const child of Array.from(currentNode.childNodes)) {
          if (child.contains(targetNode)) {
            nextNode = child;
            break;
          }
        }
        if (!nextNode) {
          throw new Error('target is not in subtree');
        }
        currentNode = nextNode;
      }
      return depth;
    }

    static getTextArrFromNode(node, coveredNodes, unsatisfied) {
      if (coveredNodes.includes(node)) {
        return [];
      }
      coveredNodes.push(node);
      if (node.nodeType === 3) {
        const words = getWordArr(node.textContent || '');
        if (words.length === 0) {
          return [];
        }
        if (words.length <= 3) {
          return [node.textContent.trim()];
        }
        if (words.length <= 5) {
          return words;
        }
        return [];
      }
      if (node.nodeType === 1) {
        let words = [];
        for (const child of Array.from(node.childNodes)) {
          if (coveredNodes.includes(child) || unsatisfied.some((unsatisfiedNode) => child.contains(unsatisfiedNode))) {
            break;
          }
          words = words.concat(this.getTextArrFromNode(child, coveredNodes, unsatisfied));
          if (words.length > MAX_ATTRIBS) {
            break;
          }
        }
        return words.slice(0, MAX_ATTRIBS);
      }
      return [];
    }

    addToken(token) {
      if (this.includes(token)) {
        return;
      }
      this._tokens.push(token);
      this.sortTokens();
    }

    clone(flushTokens = false) {
      return new SelectorNode(this.targetNode, this._root, flushTokens ? [] : this.tokens, this.maxDepth);
    }

    hasSimilarToken(token, isOnlyStem = false) {
      let tokens = this._tokens;
      if (isOnlyStem) {
        tokens = tokens.filter((item) => item.offset === 0);
      }
      for (const item of tokens) {
        if (item.equals(token)) {
          return true;
        }
      }
      return false;
    }

    includes(token, isOnlyStem = false) {
      let tokens = this._tokens;
      if (isOnlyStem) {
        tokens = tokens.filter((item) => item.offset === 0);
      }
      for (const item of tokens) {
        if (item.exacts(token)) {
          return true;
        }
      }
      return false;
    }

    get length() {
      return this._tokens.filter((token) => token.offset === 0).length;
    }

    removeToken(token) {
      const index = this._tokens.indexOf(token);
      if (index === -1) {
        throw new Error(`token not in current tree: ${token.type}, ${token.name}, ${token.value} `);
      }
      this._tokens.splice(index, 1);
      return index;
    }

    sortTokens() {
      this._tokens.sort((left, right) => {
        if (left.depth !== right.depth) {
          return left.depth - right.depth;
        }
        if (left.offset !== right.offset) {
          return left.offset - right.offset;
        }
        if (left.internalPriorityNumber !== right.internalPriorityNumber) {
          return left.internalPriorityNumber - right.internalPriorityNumber;
        }
        if (left.name !== right.name) {
          return left.name.localeCompare(right.name);
        }
        return left.value.localeCompare(right.value);
      });
    }

    get tokens() {
      return this._tokens;
    }
  }

  class Token {
    constructor(type, name, value, depth, offset, nodeRef) {
      this._value = value;
      this._type = type;
      this._name = name;
      this._depth = depth;
      this._offset = offset;
      this.nodeRef = nodeRef;
      this._metrics = null;
      this.internalPriorityNumber = Token.getInternalPriorityNumber(this.type, this.name);
    }

    get depth() {
      return this._depth;
    }

    get offset() {
      return this._offset;
    }

    get type() {
      return this._type;
    }

    get name() {
      return this._name || '';
    }

    get value() {
      return this._value || '';
    }

    get metrics() {
      if (this._metrics) {
        return this._metrics;
      }
      throw new Error('metrics not yet updated');
    }

    equals(another) {
      return this.value === another.value && this.type === another.type && this.name === another.name;
    }

    exacts(another) {
      return this.equals(another) && this.depth === another.depth && this.offset === another.offset;
    }

    getScore(weights) {
      let score = 0;
      for (const metric in this.metrics) {
        score += weights[metric] * this.metrics[metric];
      }
      return score;
    }

    updateMetrics(selectorTree, selectorTrees, rejectTrees) {
      const isOnlyStem = this.offset === 0;
      this._metrics = {
        numPaths: selectorTrees.filter((tree) => tree.hasSimilarToken(this, isOnlyStem)).length / selectorTrees.length,
        rightLean: this.depth / selectorTree.maxDepth,
        specificity: Token.getSpecificity(this.type, this.name, this.value),
        isDirectAncestor: this.offset === 0 ? 1 : 0,
        nameCssAttribProb: Token.getCSSAttribProb(this.name),
        valueCssAttribProb: Token.getCSSAttribProb(this.value),
        namePriority: Token.getNamePriority(this.name),
        valuePriority: Token.getValuePriority(this.value),
        rejectPaths: rejectTrees.filter((tree) => tree.hasSimilarToken(this, true)).length / (rejectTrees.length || 1),
        nameContainsNumber: Token.checkIfNameContainsNumber(this.name),
        valueContainsNumber: Token.checkIfContainsNumber(this.value),
        shallowRightLean: Token.getShallowRightLean(this, selectorTree),
        tokensPathsRatio: Token.getTokensPathsRatio(this, selectorTrees),
        numOfSameTokensToRight: Token.getNumOfSameTokensToRight(this, selectorTree),
        valueContainsSpecialChar: /[^a-zA-Z-_\s0-9]/.test(this.value) ? 1 : 0
      };
    }

    static createNew(type, name, value, depth, offset, nodeRef) {
      if (type === 'tag') {
        return new TokenTag(type, name, value, depth, offset, nodeRef);
      }
      if (type === 'pos') {
        return new TokenPos(type, name, value, depth, offset, nodeRef);
      }
      if (type === 'immediate') {
        return new TokenImmediate(type, name, value, depth, offset, nodeRef);
      }
      return new Token(type, name, value, depth, offset, nodeRef);
    }

    static checkIfContainsNumber(value) {
      return value.replace(/\D/g, '').length > 0 ? 1 : 0;
    }

    static checkIfNameContainsNumber(name) {
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'].includes(name)) {
        return 0;
      }
      return Token.checkIfContainsNumber(name);
    }

    static isNotRandGen(value) {
      if (value.length === 0) {
        return 1;
      }
      if (/([a-zA-Z]|\b)\d+[a-zA-Z]/.test(value)) {
        return 0;
      }
      if (/[0-9]{3,}/.test(value)) {
        return 0;
      }
      const validLength = value.replace(/[^a-zA-Z]/g, '').length;
      if (validLength === 3) {
        return ['txt', 'btn'].includes(value.toLowerCase()) ? 1 : 0;
      }
      if (validLength < 3) {
        return 0;
      }
      const words = getWordArr(value);
      if (words.length === 0) {
        return 1;
      }
      const probabilities = words.map((word) => {
        if (/\b\d{1,2}\b/.test(word)) {
          return 1;
        }
        word = word.toLowerCase();
        if (word.length > 2 && !/[aeiouy]/.test(word)) {
          return 0;
        }
        if (/[^aeiouy]{4,}/.test(word)) {
          return 0;
        }
        return 1;
      });
      return probabilities.reduce(toMin);
    }

    static isUUID(value) {
      value = value.toLowerCase();
      if (/[0-9abcdef]{8}-[0-9abcdef]{4}-[0-9abcdef]{4}-[0-9abcdef]{4}-[0-9abcdef]{12}/.test(value)) {
        return 1;
      }
      value = value.replace(/[\-_]/g, '');
      if (value.length === 32 && !/[hijklmnopqrstuvwxyz]/.test(value)) {
        return 1;
      }
      return 0;
    }

    static getCSSAttribProb(value) {
      if (value === '') {
        return 0;
      }
      const words = getWordArr(value);
      const scores = words.map((word) => {
        word = word.toLowerCase();
        for (const badWord of cssWords) {
          if (word === badWord) {
            return 1;
          }
        }
        return 0;
      });
      return scores.reduce(toMean);
    }

    static getInternalPriorityNumber(type, name) {
      if (type === 'tag') return 0;
      if (type === 'attrib' && name === 'id') return 1;
      if (type === 'attrib' && name === 'class') return 2;
      if (type === 'attrib') return 3;
      if (type === 'attribOnly') return 4;
      if (type === 'attribStart') return 5;
      if (type === 'attribContain') return 6;
      if (type === 'attribEnd') return 7;
      if (type === 'text') return 8;
      if (type === 'pos') return 9;
      if (type === 'immediate') return 10;
      throw new Error(`unhandled case in getInternalPriorityNumber ${type} ${name} `);
    }

    static getNamePriority(name) {
      name = name.toLowerCase();
      if (name.startsWith('aria-')) return 1;
      if (priorityNames1.includes(name)) return 1;
      if (priorityNames2.includes(name)) return 0.7;
      return 0;
    }

    static getNumOfSameTokensToRight(token, tree) {
      return tree.tokens.filter((item) => (
        item.equals(token)
        && (item.depth > token.depth || item.depth === token.depth && item.offset > token.offset)
      )).length;
    }

    static getShallowRightLean(token, selectorTree) {
      const nodeRefs = selectorTree.tokens
        .filter((item) => item.offset === 0)
        .sort((left, right) => left.depth - right.depth)
        .map((item) => item.nodeRef);
      const childCountList = [...new Set(nodeRefs)].map((node) => node.childNodes.length);
      const totalShallowDepth = childCountList.slice(0, selectorTree.length).filter((count) => count > 1).length + 1;
      const currentTokenShallowDepth = childCountList.slice(0, token.depth).filter((count) => count > 1).length + 1;
      return currentTokenShallowDepth / totalShallowDepth;
    }

    static getSpecificity(type) {
      if (type === 'attrib') return 0.8;
      if (type === 'attribStart') return 0.75;
      if (type === 'attribEnd') return 0.725;
      if (type === 'attribContain') return 0.7;
      if (type === 'attribOnly') return 0.6;
      if (type === 'text') return 0.55;
      if (type === 'tag') return 0.5;
      if (type === 'pos') return 0.3;
      if (type === 'immediate') return 0.2;
      throw new Error(`unknown token: ${type}`);
    }

    static getTokensPathsRatio(token, selectorTrees) {
      let count = 0;
      for (const tree of selectorTrees) {
        for (const item of tree.tokens.filter((candidate) => candidate.offset === 0)) {
          if (item.equals(token)) {
            count++;
          }
        }
      }
      const ratio = count / selectorTrees.length;
      return Math.exp(3.5 * (1 - ratio + Math.log(ratio)));
    }

    static getValuePriority(value) {
      value = value.toLowerCase();
      if (priorityValues1.some((candidate) => value.includes(candidate))) return 1;
      if (priorityValues2.some((candidate) => value.includes(candidate))) return 0.5;
      return 0;
    }
  }

  class TokenTag extends Token {
    updateMetrics(selectorTree, selectorTrees, rejectTrees) {
      super.updateMetrics(selectorTree, selectorTrees, rejectTrees);
      this._metrics.valueCssAttribProb = 0;
      this._metrics.nameContainsNumber = 0;
      this._metrics.valueContainsNumber = 0;
    }
  }

  class TokenPos extends Token {
    updateMetrics(selectorTree, selectorTrees, rejectTrees) {
      super.updateMetrics(selectorTree, selectorTrees, rejectTrees);
      this._metrics.namePriority = priorityPos.includes(this.name.toLocaleLowerCase()) ? 0.65 : 0;
      this._metrics.valueCssAttribProb = 0;
      this._metrics.nameContainsNumber = 0;
      this._metrics.valueContainsNumber = 0;
    }
  }

  class TokenImmediate extends Token {
    getScore(weights) {
      return this._metrics ? super.getScore(weights) : 0;
    }

    updateMetrics(selectorTree, selectorTrees, rejectTrees) {
      super.updateMetrics(selectorTree, selectorTrees, rejectTrees);
      this._metrics.valueCssAttribProb = 0;
      this._metrics.nameContainsNumber = 0;
      this._metrics.valueContainsNumber = 0;
    }
  }

  function getLeftSibling(node) {
    if (node.parentNode && node.parentNode.children.length > 0) {
      const children = Array.from(node.parentNode.children);
      const nodeIndex = children.indexOf(node);
      let index = nodeIndex - 1;
      while (index >= 0) {
        if (!excludeTags.includes(children[index].nodeName.toLowerCase())) {
          return { node: children[index], immediate: nodeIndex - index === 1 };
        }
        index--;
      }
    }
    return null;
  }

  const coreWeights = {
    numPaths: 8,
    rightLean: 2,
    specificity: 3,
    isDirectAncestor: 2,
    nameCssAttribProb: -4,
    valueCssAttribProb: -4,
    namePriority: 2,
    valuePriority: 1,
    rejectPaths: 0,
    nameContainsNumber: -2,
    valueContainsNumber: -1,
    shallowRightLean: 1,
    tokensPathsRatio: 1,
    numOfSameTokensToRight: -1,
    valueContainsSpecialChar: -2
  };

  class Core {
    constructor(options) {
      this._selected = new XSet();
      this._rejected = new XSet();
      this._doc = typeof document === 'undefined' ? null : document;
      this._root = this._doc ? this._doc.documentElement : null;
      this._queryCache = new Map();
      this._selectorTrees = new XSet();
      this._startTime = 0;
      this._options = options;
      this._tokenOpts = {
        text: true,
        partAttrib: true,
        immediate: true,
        siblingNodes: true,
        selectorType: 'CSS'
      };
      this._weights = coreWeights;
      this._unionSeparator = ' , ';
      this.debug = Boolean(options && options.debug);
    }

    reset() {
      this._selected = new XSet();
      this._rejected = new XSet();
      this._selectorTrees = new XSet();
      this._root = this._options && this._options.root ? this._options.root : this._doc.documentElement;
      this._queryCache = new Map();
    }

    get selected() {
      return [...this._selected];
    }

    _buildQuery() {
      throw new Error('Method not Implemented');
    }

    _checkTreeValidity(tree) {
      const queried = this._query(tree);
      return queried.length > 0 && queried.has(tree.targetNode);
    }

    _getOrderedTokens(selectorTrees) {
      const rejectorTrees = this._getSelectorTreeArr(this._rejected);
      const tokens = [...selectorTrees.first.tokens];
      this._updateTokenMetrics(tokens, selectorTrees, rejectorTrees);
      return this._orderTokens(tokens);
    }

    _getSelectorTreeArr(unsatisfied) {
      if (!this._root) {
        throw new Error('root node not set');
      }
      return unsatisfied.mapToSet((node) => SelectorNode.buildTree(
        node,
        this._root,
        this._tokenOpts,
        unsatisfied.toArray(),
        this._options && this._options.filterCallback
      ));
    }

    _orderTokens(tokens) {
      const tokenSorter = this._options && this._options.tokenSorter;
      if (typeof tokenSorter !== 'undefined') {
        const sorted = tokenSorter(tokens);
        if (sorted && typeof sorted.then === 'function') {
          throw new Error('async tokenSorter is not supported by the synchronous selector engine');
        }
        return sorted;
      }
      tokens.sort((left, right) => {
        const leftScore = left.getScore(this._weights);
        const rightScore = right.getScore(this._weights);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        if (left.type === 'text' && right.type === 'text') {
          if (left.offset !== right.offset) {
            return right.offset - left.offset;
          }
          return -1;
        }
        if (left.name === right.name) {
          return right.value.length - left.value.length;
        }
        return left.name.length + left.value.length - (right.name.length + right.value.length);
      });
      return tokens;
    }

    _predict() {
      this._selectorTrees = new XSet();
      let unsatisfied = this._selected.clone();
      let count = 0;
      this._startTime = Date.now();
      while (unsatisfied.length > 0) {
        this._timeout();
        let selectorTree = this._simplify(unsatisfied);
        const predictions = this._query(selectorTree);
        unsatisfied = unsatisfied.difference(predictions);
        if (unsatisfied.length > 0) {
          selectorTree = this._simplify(predictions);
        }
        this._selectorTrees.add(selectorTree);
        count += 1;
        if (count > this._selected.length) {
          throw new Error('stuck in loop');
        }
      }
      return this._selectorTrees.map((tree) => this._buildQuery(tree)).join(this._unionSeparator);
    }

    _query(selectorTree) {
      const selector = this._buildQuery(selectorTree);
      if (!this._queryCache.has(selector)) {
        this._queryCache.set(selector, this._querySelectorAll(selector));
      }
      return this._queryCache.get(selector);
    }

    _querySelectorAll() {
      throw new Error('method not implemented');
    }

    _removeBadTokens(selectorTree) {
      const tree = selectorTree.clone();
      const tokens = tree.tokens;
      for (let index = 0; index < tokens.length; index++) {
        if (
          tokens[index].type === 'pos'
          && (index === 0 || tokens[index - 1].depth !== tokens[index].depth || tokens[index - 1].offset !== tokens[index].offset)
        ) {
          tokens.splice(index, 1);
        }
      }
      for (let index = 0; index < tokens.length; index++) {
        if (
          tokens[index].type === 'immediate'
          && (index === 0 || tokens[index - 1].depth !== tokens[index].depth || tokens[index - 1].offset !== tokens[index].offset)
        ) {
          tokens.splice(index, 1);
        }
      }
      return tree;
    }

    _timeout() {
      if (this._options && this._options.timeout && Date.now() - this._startTime > this._options.timeout) {
        this.reset();
        throw new Error(`Time limit exceeded, took more than ${this._options.timeout}ms to generate selectors`);
      }
    }

    _updateTokenMetrics(tokens, selectorTrees, rejectorTrees) {
      for (const token of tokens) {
        token.updateMetrics(selectorTrees.first, selectorTrees.toArray(), rejectorTrees.toArray());
      }
    }

    _updateRoot() {
      if (this.selected.length === 0) {
        return;
      }
      this._queryCache = new Map();
      this._doc = this._selected.first.ownerDocument;
      if (this._options && this._options.root) {
        this._root = this._options.root;
        if (this._root.ownerDocument !== this._doc) {
          throw new Error('root node does not belong to the same document');
        }
      } else {
        this._root = this._doc.documentElement;
      }
      for (const node of this._selected) {
        if (node.ownerDocument !== this._doc) {
          throw new Error('elements do not belong to the same document');
        }
      }
      for (const node of this._rejected) {
        if (node.ownerDocument !== this._doc) {
          throw new Error('elements do not belong to the same document');
        }
      }
    }
  }

  class Get extends Core {
    constructor(selected, options) {
      super(options);
      this._selected = new XSet(selected);
      this._updateRoot();
    }

    _checkConvergence(selectorTree, lastQueried, unsatisfied) {
      const queried = this._query(selectorTree);
      if (!this._checkTreeValidity(selectorTree)) {
        throw new Error(`not a valid tree was built ${this._buildQuery(selectorTree)}`);
      }
      if (queried.isEqualTo(unsatisfied)) return 2;
      if (queried.isSubsetOf(unsatisfied)) return 3;
      if (queried.isSubsetOf(lastQueried) && !queried.isEqualTo(lastQueried)) return 1;
      return 0;
    }

    _addToken(selectorTree, token, unsatisfied) {
      const tree = selectorTree.clone();
      const lastQueried = this._query(tree);
      tree.addToken(token);
      return { convergence: this._checkConvergence(tree, lastQueried, unsatisfied), tree };
    }

    _shakeTree(tree, tokenBuildOrder) {
      const queried = this._query(tree);
      let tokens = tokenBuildOrder.filter((token) => tree.tokens.includes(token));
      tokens = tokens.reverse();
      for (const token of tokens) {
        tree.removeToken(token);
        const newQueried = this._query(tree);
        if (!newQueried.isSubsetOf(this._selected) || !newQueried.has(tree.targetNode) || !queried.isSubsetOf(newQueried)) {
          tree.addToken(token);
        }
      }
    }

    _simplify(unsatisfied) {
      const selectorTrees = this._getSelectorTreeArr(unsatisfied);
      const tokenBuildOrder = this._getOrderedTokens(selectorTrees);
      if (!this._checkTreeValidity(selectorTrees.first) || this._query(selectorTrees.first).length !== 1) {
        this.reset();
        throw new Error(`not a valid tree was built ${this._buildQuery(selectorTrees.first)}`);
      }
      let selectorTree = selectorTrees.first.clone(true);
      let convergence = 0;
      for (const token of tokenBuildOrder) {
        this._timeout();
        const status = this._addToken(selectorTree, token, unsatisfied);
        selectorTree = status.tree;
        convergence = status.convergence;
        if (convergence >= 2) {
          break;
        }
      }
      this._shakeTree(selectorTree, tokenBuildOrder);
      return selectorTree;
    }
  }

  class GetCSS extends Get {
    constructor(selected, options) {
      super(selected, options);
      this._tokenOpts.text = false;
      this._unionSeparator = ' , ';
    }

    _buildQuery(selectorTree) {
      return buildCSSQuery(this._removeBadTokens(selectorTree));
    }

    _querySelectorAll(selector) {
      if (!selector) {
        return new XSet();
      }
      if (!this._doc) {
        throw new Error('document not set');
      }
      if (!this._root) {
        throw new Error('root node not set');
      }
      return new XSet(Array.from(this._root.querySelectorAll(selector)));
    }
  }

  function withDefaultTimeout(options) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'timeout')) {
      return options;
    }
    return { ...(options || {}), timeout: 500 };
  }

  function getCSSForSelected(selected, options) {
    if (
      selected.length === 1
      && !selected[0].parentElement
      && selected[0].getRootNode().constructor.name !== 'ShadowRoot'
    ) {
      return ':root';
    }
    return new GetCSS(selected, withDefaultTimeout(options))._predict();
  }

  function isShadowRoot(node) {
    return node && node.constructor && node.constructor.name === 'ShadowRoot';
  }

  function getAllShadowHostsAlongPath(node, ownerDocument) {
    const shadowHosts = [];
    let currentRootNode = node.getRootNode();
    while (currentRootNode !== ownerDocument) {
      let host = currentRootNode;
      if (currentRootNode.nodeType === 11) {
        host = currentRootNode.host;
        shadowHosts.push(host);
      }
      currentRootNode = host.getRootNode();
    }
    return shadowHosts;
  }

  function getExtendedCSS(elements, options) {
    let selectedNodes = Array.from(elements || []);
    const lightDOMNodes = selectedNodes.filter((node) => !isShadowRoot(node.getRootNode()));
    selectedNodes = selectedNodes.filter((node) => isShadowRoot(node.getRootNode()));
    const lightDOMSelector = getCSSForSelected(lightDOMNodes, options);
    const groupedNodes = new Map();
    for (const node of selectedNodes) {
      const rootNode = node.getRootNode();
      if (!groupedNodes.has(rootNode)) {
        groupedNodes.set(rootNode, []);
      }
      groupedNodes.get(rootNode).push(node);
    }
    const shadowSelectors = [];
    for (const [rootNode, nodes] of groupedNodes.entries()) {
      const shadowHosts = getAllShadowHostsAlongPath(nodes[0], nodes[0].ownerDocument);
      shadowHosts.reverse();
      const hostSelectors = [];
      for (const host of shadowHosts) {
        hostSelectors.push(getCSSForSelected([host], {
          ...(options || {}),
          root: host.getRootNode() === host.ownerDocument ? host.ownerDocument.documentElement : host.getRootNode()
        }));
      }
      const targetSelector = getCSSForSelected(nodes, { ...(options || {}), root: rootNode });
      shadowSelectors.push([...hostSelectors, targetSelector].join(' '));
    }
    return [lightDOMSelector, ...shadowSelectors].filter(Boolean).join(',');
  }

  function getCSS(element, options) {
    return getCSSForSelected(element ? [element] : [], options);
  }

  globalThis.__openStillReferenceSelector = Object.freeze({
    getCSS,
    getExtendedCSS
  });
})();
