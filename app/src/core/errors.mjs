// Engram 引擎的錯誤型別：所有對外 API 只丟 EngramError，外殼依 code 決定顯示方式。

export const E = Object.freeze({
  LOCKED: 'E_LOCKED',
  NOT_BOUND: 'E_NOT_BOUND',
  OFFLINE: 'E_OFFLINE',
  AUTH: 'E_AUTH',
  PROXY: 'E_PROXY',
  PUSH_PROTECTED: 'E_PUSH_PROTECTED',
  CONFLICT: 'E_CONFLICT',
  COLLISION: 'E_COLLISION',
  INVALID: 'E_INVALID',
  NOT_FOUND: 'E_NOT_FOUND',
  GIT: 'E_GIT',
  SECRET: 'E_SECRET',
});

export class EngramError extends Error {
  /**
   * @param {string} code  E 裡的其中一個值
   * @param {string} message  給人看的說明（正體中文；英文版用 withEn 附上）
   * @param {string} [hint]  建議的下一步
   * @param {object} [details]
   */
  constructor(code, message, hint = '', details = undefined) {
    super(message);
    this.name = 'EngramError';
    this.code = code;
    this.hint = hint;
    if (details !== undefined) this.details = details;
  }

  /**
   * 附上英文版（管理介面切到英文時顯示）；回傳自己，可以直接 throw。命令列一律顯示中文。
   * @param {string} message
   * @param {string} [hint]
   */
  withEn(message, hint = '') {
    this.en = { message, ...(hint ? { hint } : {}) };
    return this;
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, ...(this.details ? { details: this.details } : {}), ...(this.en ? { en: this.en } : {}) };
  }
}

/**
 * 斷言；失敗時丟 E_INVALID。
 * @param {{ message: string, hint?: string }} [en]  英文版（同 EngramError#withEn）
 */
export function invariant(cond, message, hint, en) {
  if (!cond) {
    const err = new EngramError(E.INVALID, message, hint);
    throw en ? err.withEn(en.message, en.hint) : err;
  }
}
