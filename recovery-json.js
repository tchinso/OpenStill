(function (root) {
  'use strict';
  // Strings, escapes and nesting delimit complete independent JSON values.
  class RecordScanner {
    constructor(onRecord, { maxRecordChars = 16 * 1024 * 1024, maxRecordBytes = 16 * 1024 * 1024 } = {}) {
      this.onRecord = onRecord; this.maxRecordChars = maxRecordChars;
      this.maxRecordBytes = maxRecordBytes; this.tokenBytes = 0;
      this.mode = 'start'; this.offset = 0; this.metadata = {}; this.diagnostics = [];
      this.kind = 'monitor'; this.recordIndex = 0; this.token = ''; this.depth = 0; this.quoted = false; this.escape = false; this.overflow = false;
    }
    begin(mode, character) {
      this.mode = mode; this.token = ''; this.tokenBytes = 0; this.depth = 0; this.quoted = false; this.escape = false; this.overflow = false;
      this.startOffset = this.offset; this.append(character);
    }
    append(character) {
      if (!this.overflow) {
        const code = character.codePointAt(0);
        this.tokenBytes += code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code <= 0xFFFF ? 3 : 4;
        if (this.token.length + character.length > (this.mode === 'record' ? this.maxRecordChars : 1024 * 1024)
          || this.tokenBytes > (this.mode === 'record' ? this.maxRecordBytes : 1024 * 1024)) {
          this.overflow = true; this.token = ''; this.diagnostics.push({ offset: this.startOffset, recordIndex: this.recordIndex, error: '독립 레코드 바이트 예산을 넘어 원본 파일에 보관했습니다.' });
        } else this.token += character;
      }
      if (this.quoted) {
        if (this.escape) this.escape = false;
        else if (character === '\\') this.escape = true;
        else if (character === '"') this.quoted = false;
      } else if (character === '"') this.quoted = true;
      else if (character === '{' || character === '[') this.depth += 1;
      else if (character === '}' || character === ']') this.depth -= 1;
    }
    async complete() {
      let parsed; let valid = false;
      if (!this.overflow) {
        try {
          parsed = JSON.parse(this.token); valid = true;
        } catch (error) {
          this.diagnostics.push({ offset: this.startOffset, recordIndex: this.recordIndex, field: this.key, error: error.message });
        }
      }
      if (valid) {
        if (this.mode === 'record') await this.onRecord(parsed, this.kind, { recordIndex: this.recordIndex, offset: this.startOffset });
        else this.metadata[this.key] = parsed;
      }
      if (this.mode === 'record') this.recordIndex += 1;
      this.token = '';
    }
    async write(text) {
      for (const character of text) {
        this.offset += character.length;
        if (this.mode === 'record' || this.mode === 'value') {
          if (!this.quoted && this.depth === 0 && (character === ',' || character === ']' || character === '}')) {
            const wasRecord = this.mode === 'record'; await this.complete();
            if (wasRecord) {
              if (character === ',') this.mode = 'array-next';
              else if (character === ']') this.mode = this.bare ? 'done' : 'after-value';
              else { this.mode = 'done'; this.diagnostics.push({ offset: this.offset, error: '배열이 닫히기 전에 객체가 끝났습니다.' }); }
            } else this.mode = character === ',' ? 'key-next' : 'done';
          } else this.append(character);
          continue;
        }
        if (this.mode !== 'key' && (/\s/.test(character) || this.offset === 1 && character === '\uFEFF')) continue;
        if (this.mode === 'start') {
          if (character === '[') { this.mode = 'array-first'; this.bare = true; }
          else if (character === '{') this.mode = 'key-first';
          else { this.mode = 'done'; this.diagnostics.push({ offset: this.offset, error: '지원되는 JSON 배열 또는 객체가 아닙니다.' }); }
        } else if (this.mode === 'key-first' || this.mode === 'key-next') {
          if (character === '}') { if (this.mode === 'key-next') this.diagnostics.push({ offset: this.offset, error: '객체 끝의 불필요한 쉼표' }); this.mode = 'done'; }
          else if (character === '"') { this.keyToken = '"'; this.keyEscape = false; this.mode = 'key'; }
          else { this.diagnostics.push({ offset: this.offset, error: '객체 필드 이름이 손상되었습니다.' }); this.mode = 'done'; }
        } else if (this.mode === 'key') {
          this.keyToken += character;
          if (this.keyEscape) this.keyEscape = false;
          else if (character === '\\') this.keyEscape = true;
          else if (character === '"') { try { this.key = JSON.parse(this.keyToken); } catch { this.key = ''; } this.mode = 'colon'; }
        } else if (this.mode === 'colon') {
          if (character === ':') this.mode = 'value-first';
          else { this.diagnostics.push({ offset: this.offset, error: '필드 구분자가 손상되었습니다.' }); this.mode = 'done'; }
        } else if (this.mode === 'value-first') {
          if (character === '[' && ['monitors', 'fragments', 'sieves', 'sieve_backup'].includes(this.key)) {
            this.kind = this.key === 'fragments' ? 'fragment' : 'monitor'; this.mode = 'array-first';
            this.metadata[this.key] = []; this.recognized = true;
          } else this.begin('value', character);
        } else if (this.mode === 'array-first' || this.mode === 'array-next') {
          if (character === ']') {
            if (this.mode === 'array-next') this.diagnostics.push({ offset: this.offset, error: '배열 끝의 불필요한 쉼표' });
            this.mode = this.bare ? 'done' : 'after-value';
          } else this.begin('record', character);
        } else if (this.mode === 'after-value') {
          if (character === ',') this.mode = 'key-next';
          else if (character === '}') this.mode = 'done';
          else { this.diagnostics.push({ offset: this.offset, error: '배열 뒤의 JSON 구분자가 손상되었습니다.' }); this.mode = 'done'; }
        } else if (this.mode === 'done' && this.diagnostics.length < 1000) this.diagnostics.push({ offset: this.offset, error: 'JSON 끝 뒤에 추가 내용이 있습니다.' });
      }
    }
    async finish() {
      // A closed independent value remains recoverable when the enclosing
      // array/envelope is truncated immediately after it.
      if ((this.mode === 'record' || this.mode === 'value') && !this.quoted && this.depth === 0 && this.token.trim()) await this.complete();
      if (this.mode !== 'done') this.diagnostics.push({ offset: this.offset, recordIndex: this.recordIndex, error: 'JSON 입력이 중간에 끝났습니다. 완전한 독립 레코드만 회수했습니다.' });
      return { metadata: this.metadata, diagnostics: this.diagnostics.slice(0, 1000), recognized: this.bare || this.recognized };
    }
  }
  root.OpenStillRecordScanner = RecordScanner;
  if (typeof module === 'object' && module.exports) module.exports = RecordScanner;
})(typeof self !== 'undefined' ? self : globalThis);
