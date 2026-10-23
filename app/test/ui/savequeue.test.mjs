// 記憶整理頁自動儲存的待送清單：送出失敗放回時，舊值不可以蓋掉新值（第四輪審查的情境）。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createSaveQueue } from '../../src/ui/src/savequeue.js';

describe('自動儲存的待送清單', () => {
  test('取出後清空；失敗放回原樣', () => {
    const q = createSaveQueue();
    q.change('i1', { decision: 'accept' });
    q.change('i2', { note: 'a' });
    const b = q.take();
    assert.equal(q.size, 0);
    assert.deepEqual(b.changes, { i1: { decision: 'accept' }, i2: { note: 'a' } });
    q.putBack(b);
    assert.deepEqual(q.snapshot(), { i1: { decision: 'accept' }, i2: { note: 'a' } });
  });

  test('送出期間又改了同一欄：放回時以新值為準', () => {
    const q = createSaveQueue();
    q.change('i1', { decision: 'accept' });
    const b = q.take();
    q.change('i1', { decision: 'archive' });
    q.putBack(b);
    assert.deepEqual(q.snapshot(), { i1: { decision: 'archive' } });
  });

  test('新值已經另外送出（離開頁面時），舊的那批失敗後不再放回', () => {
    const q = createSaveQueue();
    q.change('i1', { decision: 'accept' });
    const p1 = q.take(); // 送出中
    q.change('i1', { decision: 'archive' });
    q.take(); // 離開頁面時送出新值
    q.putBack(p1); // 舊的那批這時才失敗
    assert.equal(q.size, 0, '舊的 accept 不可以再送出去蓋掉 archive');
  });

  test('只放回沒有再改過的欄位：決定沒改、備註改過', () => {
    const q = createSaveQueue();
    q.change('i1', { decision: 'custom', note: '舊' });
    const b = q.take();
    q.change('i1', { note: '新' });
    q.take(); // 新備註已送出
    q.putBack(b);
    assert.deepEqual(q.snapshot(), { i1: { decision: 'custom' } });
  });
});
