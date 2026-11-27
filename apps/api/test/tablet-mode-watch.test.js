import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tabletModeWatch } from '../src/tablet-mode-watch.js';

test('only watchers for the saved device wake; disconnection drops the wait, tickets cannot be replayed',async()=>{
  const hub=tabletModeWatch({}),a=new EventEmitter(),b=new EventEmitter();
  const first=hub.issue('a'), second=hub.issue('b');
  const wakeA=hub.wait(first,a),wakeB=hub.wait(second,b);
  assert.equal(hub.listening('a'),true);assert.equal(hub.listening('b'),true);
  assert.throws(()=>hub.wait(first,a),error=>error.code==='TABLET_WATCH_EXPIRED');
  hub.changed('a');await wakeA;
  assert.equal(hub.listening('a'),false);assert.equal(hub.listening('b'),true);
  b.emit('close');await wakeB;assert.equal(hub.listening('b'),false);
  assert.equal(b.listenerCount('close'),0);
});
