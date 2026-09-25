const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('../spectator.user.js');

function makeCamera() {
  const number = value => ({ value, update_dleff0$(dt, next) { this.value = next; } });
  return {
    currState_0: { direction: 0 },
    pivot_0: {
      value: { x: 0, y: 0, z: 300 },
      update_sl07mc$(dt, target) { Object.assign(this.value, target); }
    },
    polarDistance_0: number(300),
    pitch_0: number(0),
    elevation_0: number(0.2)
  };
}

class FakeDocument extends EventTarget {
  constructor(camera) {
    super();
    const tank = { tag: 'LocalTank', components_0: { array: [{ followCamera_0: camera }] } };
    this.store = {
      state: { battleStatistics: { inBattle: () => true } },
      subscribers: { array: [{ tank }] }
    };
    this.rootElement = { _reactRootContainer: { _internalRoot: { current: {
      memoizedState: { element: { type: { prototype: { store: this.store } } } }
    } } } };
    this.documentElement = { appendChild: element => { this.panel = element; } };
    this.hidden = false;
    this.activeElement = null;
    this.pointerLockElement = null;
    this.status = { textContent: '', className: '' };
    this.button = new EventTarget();
    this.button.textContent = '';
    this.shadow = { querySelector: selector => selector === '#status' ? this.status : this.button };
    this.canvas = {
      requestPointerLock: () => {
        this.pointerLockElement = this.canvas;
        this.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      }
    };
    this.exitPointerLock = () => {
      this.pointerLockElement = null;
      this.dispatchEvent(new Event('pointerlockchange'));
    };
  }

  getElementById(id) { return id === 'root' ? this.rootElement : null; }
  querySelector(selector) { return selector === 'canvas' ? this.canvas : null; }
  createElement() {
    const element = new EventTarget();
    element.style = {};
    element.attachShadow = () => this.shadow;
    return element;
  }
}

class FakeWindow extends EventTarget {
  constructor(doc) {
    super();
    this.document = doc;
    this.frames = new Map();
    this.nextFrame = 0;
    this.requestAnimationFrame = callback => {
      const id = ++this.nextFrame;
      this.frames.set(id, callback);
      return id;
    };
    this.cancelAnimationFrame = id => this.frames.delete(id);
    this.setInterval = callback => { this.interval = callback; return 1; };
    this.clearInterval = () => { this.interval = null; };
  }

  frame(time) {
    const [id, callback] = this.frames.entries().next().value;
    this.frames.delete(id);
    callback(time);
  }
}

function send(win, name, properties = {}) {
  const event = new Event(name, { cancelable: true });
  Object.assign(event, properties);
  win.dispatchEvent(event);
  return event;
}

test('installed userscript blocks game movement, flies, releases lock and restores on F8', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  const originalPivot = camera.pivot_0.update_sl07mc$;
  bootstrap(win);
  assert.ok(doc.panel);
  const gameInputs = [];
  const gamePointers = [];
  win.addEventListener('keydown', event => gameInputs.push(event.code), true);
  win.addEventListener('pointermove', event => gamePointers.push(event.type), true);

  send(win, 'keydown', { code: 'KeyW' }); // Held before activating; game must see keyup.
  send(win, 'keydown', { code: 'F8' });
  assert.match(doc.status.textContent, /отпустите клавиши/);
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  send(win, 'keyup', { code: 'KeyW' });

  send(win, 'keydown', { code: 'F8' });
  assert.match(doc.status.textContent, /откреплена/);
  const callsBeforeFlight = gameInputs.length;
  assert.equal(send(win, 'keydown', { code: 'KeyW' }).defaultPrevented, true);
  assert.equal(gameInputs.length, callsBeforeFlight);
  send(win, 'pointermove', { button: -1 });
  assert.equal(gamePointers.length, 0);
  win.frame(16);
  win.frame(32);
  assert.notEqual(camera.pivot_0.value.y, -300);
  assert.equal(send(win, 'wheel', { deltaY: -200 }).defaultPrevented, true);
  assert.match(doc.status.textContent, /ед\/с/);

  send(win, 'mousedown', { button: 2 });
  assert.equal(doc.pointerLockElement, doc.canvas);
  send(win, 'mousemove', { movementX: 50, movementY: 5 });
  assert.ok(camera.currState_0.direction < 0);
  send(win, 'mouseup', { button: 2 });
  assert.equal(doc.pointerLockElement, null);

  send(win, 'keyup', { code: 'KeyW' });
  send(win, 'keydown', { code: 'F8' });
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  assert.equal(win.frames.size, 0);
  send(win, 'keydown', { code: 'KeyW' });
  assert.equal(gameInputs.at(-1), 'KeyW');
  win.dispatchEvent(new Event('pagehide'));
  assert.equal(win.interval, null);
});

test('changing battles restores the camera automatically', () => {
  const camera = makeCamera();
  const doc = new FakeDocument(camera);
  const win = new FakeWindow(doc);
  const originalPivot = camera.pivot_0.update_sl07mc$;
  bootstrap(win);
  doc.button.dispatchEvent(new Event('click'));
  assert.match(doc.status.textContent, /откреплена/);
  doc.store.state.battleStatistics.inBattle = () => false;
  win.interval();
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  assert.equal(win.frames.size, 0);
  win.dispatchEvent(new Event('pagehide'));
});
