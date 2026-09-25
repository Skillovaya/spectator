const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asArray, findStore, findLocalTank, resolveCamera, isCompatibleCamera,
  createFlight, stepFlight, lookFlight, attachFreeCamera
} = require('../spectator.user.js');

function makeCamera() {
  return {
    currState_0: { direction: 0 },
    prevState_0: { direction: 0 },
    pivot_0: {
      value: { x: 100, y: 200, z: 300 },
      update_sl07mc$(dt, target) {
        this.value.x = target.x;
        this.value.y = target.y;
        this.value.z = target.z;
      }
    },
    polarDistance_0: {
      value: 600,
      update_dleff0$(dt, target) { this.value = target; }
    },
    pitch_0: {
      value: 0,
      update_dleff0$(dt, target) { this.value = target; }
    },
    elevation_0: {
      value: 0.2,
      update_dleff0$(dt, target) { this.value = target; }
    },
    pathPosition_dl3fsr$_0: 0,
    pathPointElevation_0: 0,
    updatePathPoint_0() { this.pathUpdates = (this.pathUpdates || 0) + 1; },
    getCollisionTime_0() { return 0.4; }
  };
}

function makeStore(camera) {
  const tank = { tag: 'LocalTank', components_0: { array: [{ followCamera_0: camera }] } };
  return {
    state: { battleStatistics: { inBattle: () => true } },
    subscribers: { array_hd7ov6$_0: [{ tank }] }
  };
}

function docFor17(store) {
  const fiber = { memoizedState: { element: { type: { prototype: { store } } } } };
  return { getElementById: () => ({ _reactRootContainer: { _internalRoot: { current: fiber } } }) };
}

test('finds a local battle camera through the React 17 store', () => {
  const camera = makeCamera();
  const store = makeStore(camera);
  const doc = docFor17(store);
  assert.equal(findStore(doc), store);
  assert.equal(findLocalTank(store).tag, 'LocalTank');
  assert.deepEqual(resolveCamera(doc), { camera, message: '' });
});

test('a store unmounting mid-read does not throw or patch a camera', () => {
  const doc = { getElementById: () => { throw Error('unmounted'); } };
  assert.equal(resolveCamera(doc).camera, null);
  assert.match(resolveCamera(doc).message, /Ожидание/);
});

test('finds a store in a React 18 Fiber child and handles missing battle', () => {
  const store = makeStore(makeCamera());
  const doc = { getElementById: () => ({
    '__reactContainer$abc': { child: { sibling: { stateNode: { store } } } }
  }) };
  assert.equal(findStore(doc), store);
  store.state.battleStatistics.inBattle = () => false;
  assert.equal(resolveCamera(doc).camera, null);
  assert.match(resolveCamera(doc).message, /Откройте бой/);
});

test('supports the game-mode possessed tank layout and reports unknown camera shapes', () => {
  const camera = makeCamera();
  const tank = { components_0: { array: [{ FollowCamera: camera }] } };
  const world = { entities_0: { array: [{ components_0: { array: [
    { gameMode_0: { possesedTank: tank } }
  ] } }] } };
  const store = {
    state: { battleStatistics: { battleLoaded: true } },
    subscribers: { toArray: () => [{ tank: { world } }] }
  };
  assert.equal(findLocalTank(store), tank);
  assert.equal(resolveCamera(docFor17(store)).camera, camera);
  delete camera.pitch_0.update_dleff0$;
  assert.equal(isCompatibleCamera(camera), false);
  assert.equal(resolveCamera(docFor17(store)).camera, null);
  assert.match(resolveCamera(docFor17(store)).message, /не поддерживается/);
});

test('prefers a real FollowCamera over a similarly named controller', () => {
  const camera = makeCamera();
  const tank = { tag: 'LocalTank', components_0: { array: [{
    followCameraHeightController_0: { up_0: false },
    followCamera_0: camera
  }] } };
  const store = { state: {}, subscribers: { array: [{ tank }] } };
  assert.equal(resolveCamera(docFor17(store)).camera, camera);
});

test('unwraps Kotlin collection layouts and ignores malformed collections', () => {
  assert.deepEqual(asArray({ toArray: () => [1, 2] }), [1, 2]);
  assert.deepEqual(asArray({ toArray: () => { throw Error('unmounted'); }, array: [3] }), [3]);
  assert.deepEqual(asArray({ array_hd7ov6$_0: [4] }), [4]);
  assert.deepEqual(asArray({}), []);
});

test('flight moves in the camera direction, normalizes diagonals and caps frame time', () => {
  const flight = createFlight(makeCamera(), 1000);
  assert.deepEqual(flight.position, { x: 100, y: -400, z: 450 });
  stepFlight(flight, new Set(['KeyW']), 1); // 50 ms, not a full second.
  assert.equal(flight.position.y, -350);
  stepFlight(flight, new Set(['KeyD']), 0.02);
  assert.equal(flight.position.x, 120);
  stepFlight(flight, new Set(['KeyE']), 0.02);
  assert.equal(flight.position.z, 470);
  const before = { ...flight.position };
  stepFlight(flight, new Set(['KeyW', 'KeyD']), 0.02);
  assert.ok(Math.abs(Math.hypot(flight.position.x - before.x, flight.position.y - before.y) - 20) < 1e-10);
  const fast = flight.position.y;
  stepFlight(flight, new Set(['KeyW', 'ShiftLeft']), 0.01);
  assert.equal(flight.position.y - fast, 40);
});

test('look controls clamp pitch and W follows the vertical view angle', () => {
  const flight = createFlight(makeCamera(), 1000);
  lookFlight(flight, 400, -10000);
  assert.ok(flight.yaw < 0);
  assert.ok(flight.pitch > -Math.PI / 2);
  const previousZ = flight.position.z;
  stepFlight(flight, new Set(['KeyW']), 0.02);
  assert.ok(flight.position.z > previousZ);
  lookFlight(flight, 0, 20000);
  assert.ok(flight.pitch < Math.PI / 2);
  const previousYaw = flight.yaw;
  stepFlight(flight, new Set(['ArrowLeft']), 0.02);
  assert.ok(flight.yaw > previousYaw);
});

test('camera hooks detach, fly and restore only camera state', () => {
  const camera = makeCamera();
  const tankPosition = { x: 999, y: 888, z: 777 };
  const original = {
    pivot: camera.pivot_0.update_sl07mc$,
    number: camera.polarDistance_0.update_dleff0$,
    collision: camera.getCollisionTime_0
  };
  const flight = createFlight(camera);
  const adapter = attachFreeCamera(camera, flight);
  assert.equal(camera.currState_0.direction, 0);
  camera.currState_0.direction = 1.25; // A regular game update is hidden while flying.
  assert.equal(camera.currState_0.direction, 0);
  camera.prevState_0.direction = 2;
  camera.pivot_0.update_sl07mc$(0.01, tankPosition);
  assert.deepEqual(camera.pivot_0.value, flight.position);
  assert.deepEqual(tankPosition, { x: 999, y: 888, z: 777 });
  camera.polarDistance_0.update_dleff0$(0.01, 999);
  camera.pitch_0.update_dleff0$(0.01, 0.9);
  assert.equal(camera.polarDistance_0.value, 10);
  assert.equal(camera.pitch_0.value, flight.pitch);
  assert.equal(camera.getCollisionTime_0(), 1);

  flight.position.x += 30;
  lookFlight(flight, 10, 10);
  adapter.sync();
  assert.equal(camera.pivot_0.value.x, flight.position.x);
  assert.equal(camera.pathPosition_dl3fsr$_0, flight.pitch);

  adapter.detach();
  assert.equal(camera.pivot_0.update_sl07mc$, original.pivot);
  assert.equal(camera.polarDistance_0.update_dleff0$, original.number);
  assert.equal(camera.getCollisionTime_0, original.collision);
  assert.deepEqual(camera.pivot_0.value, tankPosition);
  assert.equal(camera.polarDistance_0.value, 600);
  assert.equal(camera.pathPosition_dl3fsr$_0, 0);
  assert.equal(camera.currState_0.direction, 1.25);
  assert.equal(camera.prevState_0.direction, 2);
  camera.pivot_0.update_sl07mc$(0.01, { x: 3, y: 4, z: 5 });
  assert.deepEqual(camera.pivot_0.value, { x: 3, y: 4, z: 5 });
});

test('restores a direction inherited from the camera-state prototype', () => {
  const camera = makeCamera();
  const state = Object.create({ direction: 0 });
  camera.currState_0 = state;
  const flight = createFlight(camera);
  flight.yaw = 1;
  const adapter = attachFreeCamera(camera, flight);
  state.direction = 2;
  assert.equal(state.direction, 1);
  adapter.detach();
  assert.equal(state.direction, 2);
  assert.equal(Object.getOwnPropertyDescriptor(state, 'direction').value, 2);
});

test('failure midway through installation rolls back earlier hooks', () => {
  const camera = makeCamera();
  const originalPivot = camera.pivot_0.update_sl07mc$;
  Object.defineProperty(camera.elevation_0, 'update_dleff0$', {
    value: camera.elevation_0.update_dleff0$, writable: false, configurable: false
  });
  assert.throws(() => attachFreeCamera(camera, createFlight(camera)), /подключить камеру|read only/);
  assert.equal(camera.pivot_0.update_sl07mc$, originalPivot);
  assert.equal(camera.currState_0.direction, 0);
  assert.equal(Object.getOwnPropertyDescriptor(camera.currState_0, 'direction').get, undefined);
  assert.deepEqual(camera.pivot_0.value, { x: 100, y: 200, z: 300 });
});

test('a replaced camera state fails closed instead of flying an old camera', () => {
  const camera = makeCamera();
  const adapter = attachFreeCamera(camera, createFlight(camera));
  camera.currState_0 = { direction: 3 };
  assert.throws(() => adapter.sync(), /сменилась/);
  adapter.detach();
  assert.equal(camera.currState_0.direction, 3);
});
