const test = require('node:test');
const assert = require('node:assert/strict');
const {
  asArray, findStore, findLocalTank, resolveCamera, isCompatibleCamera,
  cameraProblems, createDiagnostics, safeError, createFlight, stepFlight,
  lookFlight, attachFreeCamera
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

function docForFiber(fiber) {
  const root = { children: [] };
  const canvas = { parentElement: root, '__reactFiber$canvas': fiber };
  return { getElementById: () => root, querySelector: () => canvas };
}

test('finds a local battle camera through the React 17 store', () => {
  const camera = makeCamera();
  const store = makeStore(camera);
  const doc = docFor17(store);
  assert.equal(findStore(doc), store);
  assert.equal(findLocalTank(store).tag, 'LocalTank');
  assert.deepEqual(resolveCamera(doc), { camera, code: 'READY', message: '' });
});

test('diagnostic trace distinguishes a missing root, store, tank and camera', () => {
  const absent = {};
  assert.equal(resolveCamera({ getElementById: () => null }, absent).code, 'ROOT_MISSING');
  assert.deepEqual(absent.root, { found: false, canvasFound: false, childCount: null });

  const noStore = {};
  const rootWithoutStore = { getElementById: () => ({ '__reactContainer$abc': { child: {} } }) };
  assert.equal(resolveCamera(rootWithoutStore, noStore).code, 'CAMERA_PATH_NOT_FOUND');
  assert.equal(noStore.react.handle, 'react18');
  assert.ok(noStore.react.nodesChecked > 0);
  assert.ok(noStore.discovery.fibers > 0);
  assert.equal(noStore.discovery.objectsChecked, 0);

  const store = makeStore(makeCamera());
  store.subscribers.array_hd7ov6$_0 = [{ tank: { tag: 'EnemyTank' } }];
  const missingTank = {};
  assert.equal(resolveCamera(docFor17(store), missingTank).code, 'LOCAL_TANK_NOT_FOUND');
  assert.equal(missingTank.store.subscribers.count, 1);
  assert.equal(missingTank.store.subscriberSample[0].isLocalTank, false);

  store.subscribers.array_hd7ov6$_0 = [{ tank: { tag: 'LocalTank', components_0: { array: [] } } }];
  const missingCamera = {};
  assert.equal(resolveCamera(docFor17(store), missingCamera).code, 'CAMERA_NOT_FOUND');
  assert.equal(missingCamera.cameraSearch.componentCount, 0);
});

test('a store unmounting mid-read does not throw or patch a camera', () => {
  const doc = { getElementById: () => { throw Error('unmounted'); } };
  const trace = {};
  assert.equal(resolveCamera(doc, trace).code, 'PROBE_EXCEPTION');
  assert.match(trace.error.message, /unmounted/);
});

test('finds a store in a React 18 Fiber child and handles missing battle', () => {
  const store = makeStore(makeCamera());
  const doc = { getElementById: () => ({
    '__reactContainer$abc': { child: { sibling: { stateNode: { store } } } }
  }) };
  assert.equal(findStore(doc), store);
  store.state.battleStatistics.inBattle = () => false;
  assert.equal(resolveCamera(doc).camera, null);
  assert.equal(resolveCamera(doc).code, 'BATTLE_NOT_READY');
});

test('finds a store from a canvas Fiber when #root has no React handle', () => {
  const store = makeStore(makeCamera());
  const root = { children: [] };
  const canvas = { parentElement: root };
  const fiber = { return: { memoizedProps: { store } } };
  canvas['__reactFiber$private-random-suffix'] = fiber;
  const doc = {
    getElementById: () => root,
    querySelector: () => canvas,
    body: { children: [root] }
  };
  const trace = {};
  assert.equal(resolveCamera(doc, trace).code, 'READY');
  assert.equal(trace.react.handle, 'fiber');
  assert.equal(trace.react.source, 'canvas');
  assert.deepEqual(trace.react.markers, { react17: 0, react18: 0, fiber: 1 });
  assert.equal(trace.react.nodesChecked, 2);
  assert.ok(trace.react.domNodesChecked >= 3);
  const diagnostics = createDiagnostics({ location: { hostname: 'tankionline.com' } });
  diagnostics.record('info', 'CAMERA_PROBE', { trace });
  assert.ok(!diagnostics.report().includes('private-random-suffix'));
});

test('finds a React container in a sibling of #root without walking globals', () => {
  const store = makeStore(makeCamera());
  const root = { children: [] };
  const sibling = { children: [], '__reactContainer$random-suffix': { current: {
    child: { memoizedState: { store } }
  } } };
  const body = { children: [root, sibling] };
  const trace = {};
  assert.equal(findStore({ getElementById: () => root, body }, trace), store);
  assert.equal(trace.react.handle, 'react18');
  assert.equal(trace.react.source, 'descendant');
  assert.equal(trace.react.storePath, 'memoizedState.store');
});

test('finds a store in a descendant Fiber hook and bounds cyclic Fiber traversal', () => {
  const store = makeStore(makeCamera());
  const hook = { memoizedState: { store } };
  hook.next = hook;
  const fiber = { memoizedState: hook };
  fiber.alternate = fiber;
  const root = { children: [{ '__reactInternalInstance$random-suffix': fiber }] };
  const trace = {};
  assert.equal(findStore({ getElementById: () => root }, trace), store);
  assert.equal(trace.react.source, 'descendant');
  assert.equal(trace.react.storePath, 'hook[0].memoizedState.store');
  assert.equal(trace.react.nodesChecked, 1);
});

test('bounds DOM and Fiber inspection even when the tree is large or cyclic', () => {
  const rootFiber = {};
  let fiber = rootFiber;
  for (let index = 0; index < 750; index++) {
    fiber.sibling = {};
    fiber = fiber.sibling;
  }
  fiber.sibling = rootFiber;
  const root = { '__reactContainer$limited': rootFiber, children: [] };
  const body = { children: [root, ...Array.from({ length: 150 }, () => ({ children: [] }))] };
  const trace = {};
  assert.equal(findStore({ getElementById: () => root, body }, trace), null);
  assert.ok(trace.react.domNodesChecked <= 128);
  assert.equal(trace.react.nodesChecked, 700);
  assert.equal(trace.react.searchLimitReached, true);
});

test('reports a visible marker without an active Fiber separately from isolation', () => {
  const root = { '__reactContainer$not-mounted': null };
  for (let index = 0; index < 300; index++) root[`unrelated${index}`] = true;
  const trace = {};
  const result = resolveCamera({ getElementById: () => root }, trace);
  assert.equal(result.code, 'REACT_ROOT_MISSING');
  assert.match(result.message, /Fiber недоступен/);
  assert.deepEqual(trace.react.markers, { react17: 0, react18: 1, fiber: 0 });
  assert.equal(trace.react.fiberFound, false);
  assert.equal(trace.react.domKeysTruncated, 1);
});

test('reports no visible React marker even when a canvas exists', () => {
  const root = { children: [] };
  const canvas = { parentElement: root };
  const trace = {};
  assert.equal(resolveCamera({ getElementById: () => root, querySelector: () => canvas }, trace).code,
    'REACT_ROOT_MISSING');
  assert.deepEqual(trace.react.markers, { react17: 0, react18: 0, fiber: 0 });
  assert.equal(trace.react.nodesChecked, 0);
  assert.ok(trace.react.domNodesChecked >= 2);
});

test('finds a FollowCamera through React props without any store', () => {
  const camera = makeCamera();
  const trace = {};
  const doc = docForFiber({ memoizedProps: { model: { scene: { camera } } } });
  assert.equal(resolveCamera(doc, trace).camera, camera);
  assert.equal(trace.result, 'READY');
  assert.equal(trace.react.storePath, null);
  assert.equal(trace.discovery.selected, 'uniqueFollowCamera');
  assert.equal(trace.discovery.path, 'fiber.props.model.scene.camera');
});

test('direct camera discovery reports missing methods rather than patching incompatible objects', () => {
  const camera = makeCamera();
  delete camera.pitch_0.update_dleff0$;
  const trace = {};
  assert.equal(resolveCamera(docForFiber({ memoizedProps: { camera } }), trace).code,
    'CAMERA_INCOMPATIBLE');
  assert.ok(trace.discovery.candidates[0].missing.includes('pitch_0.update_dleff0$'));
});

test('does not select a directly discovered camera before a canvas appears', () => {
  const camera = makeCamera();
  const root = { '__reactContainer$app': { memoizedProps: { game: { camera } } } };
  const trace = {};
  assert.equal(resolveCamera({ getElementById: () => root }, trace).code, 'BATTLE_NOT_READY');
  assert.equal(trace.discovery.selected, 'uniqueFollowCamera');
});

test('finds a camera from React context and function-component hooks', () => {
  const camera = makeCamera();
  const doc = docForFiber({
    memoizedState: { memoizedState: { app: { gameCamera: camera } } },
    dependencies: { firstContext: { memoizedValue: { app: { gameCamera: camera } } } }
  });
  const trace = {};
  assert.equal(resolveCamera(doc, trace).camera, camera);
  assert.equal(trace.discovery.compatibleCameras, 1);
  assert.equal(trace.discovery.selected, 'uniqueFollowCamera');
});

test('prefers a local tank camera over another compatible camera', () => {
  const localCamera = makeCamera();
  const otherCamera = makeCamera();
  const local = { tag: 'LocalTank', components_0: { array: [{ followCamera_0: localCamera }] } };
  const doc = docForFiber({ memoizedProps: { game: { tank: local, camera: otherCamera } } });
  const trace = {};
  assert.equal(resolveCamera(doc, trace).camera, localCamera);
  assert.equal(trace.discovery.selected, 'localTank');
  assert.equal(trace.discovery.localTanks, 1);
  assert.equal(trace.discovery.compatibleCameras, 1);
});

test('refuses an ambiguous camera and does not read unrelated getters or log game values', () => {
  const camera = makeCamera();
  const other = makeCamera();
  camera.nickname = 'PRIVATE_PLAYER';
  camera.pivot_0.value.x = 31415926;
  let getterCalls = 0;
  const props = { game: { camera, followCamera_0: other } };
  Object.defineProperty(props, 'secretData', {
    enumerable: true, get() { getterCalls++; return { camera }; }
  });
  const trace = {};
  const result = resolveCamera(docForFiber({ memoizedProps: props }), trace);
  assert.equal(result.code, 'CAMERA_AMBIGUOUS');
  assert.equal(getterCalls, 0);
  assert.equal(trace.discovery.compatibleCameras, 2);
  const diagnostics = createDiagnostics({ location: { hostname: 'tankionline.com' } });
  diagnostics.record('warn', 'CAMERA_PROBE', { trace });
  assert.ok(!diagnostics.report().includes('PRIVATE_PLAYER'));
  assert.ok(!diagnostics.report().includes('31415926'));
  assert.ok(!diagnostics.report().includes('secretData'));
});

test('a missing camera reports bounded structural hints instead of missing store', () => {
  const trace = {};
  const doc = docForFiber({ memoizedProps: { battleController: { gameScene: { items: [] } } } });
  assert.equal(resolveCamera(doc, trace).code, 'CAMERA_PATH_NOT_FOUND');
  assert.equal(trace.discovery.cameraLike, 0);
  assert.ok(trace.discovery.hints.some(item => item.fields.includes('battleController')));
  assert.equal(trace.discovery.anchors.props, 1);
  assert.ok(trace.discovery.objectsChecked < 1200);
});

test('bounds direct object discovery on large and cyclic React state graphs', () => {
  const first = {};
  let fiber = first;
  for (let index = 0; index < 80; index++) {
    fiber.memoizedProps = {
      game: { children: Array.from({ length: 16 }, () => ({ game: { children: [] } })) }
    };
    fiber.sibling = {};
    fiber = fiber.sibling;
  }
  first.alternate = first;
  const trace = {};
  assert.equal(resolveCamera(docForFiber(first), trace).code, 'CAMERA_PATH_NOT_FOUND');
  assert.ok(trace.discovery.objectsChecked <= 1200);
  assert.ok(trace.discovery.references <= 2400);
  assert.equal(trace.discovery.limitReached, true);
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
  const trace = {};
  assert.equal(resolveCamera(docFor17(store), trace).code, 'CAMERA_INCOMPATIBLE');
  assert.ok(cameraProblems(camera).includes('pitch_0.update_dleff0$'));
  assert.ok(trace.cameraSearch.candidates[0].missing.includes('pitch_0.update_dleff0$'));
});

test('diagnostic report describes camera shape without account or position values', () => {
  const camera = makeCamera();
  camera.nickname = 'PRIVATE_PLAYER';
  camera.pivot_0.value.x = 31415926;
  delete camera.pitch_0.update_dleff0$;
  const store = makeStore(camera);
  const trace = {};
  assert.equal(resolveCamera(docFor17(store), trace).code, 'CAMERA_INCOMPATIBLE');
  const diagnostics = createDiagnostics({
    location: { hostname: 'tankionline.com' },
    console: { warn() {} }
  });
  diagnostics.record('warn', 'CAMERA_PROBE', {
    trace, authToken: 'SECRET_TOKEN_123', accountEmail: 'person@example.com', rawGame: store,
    url: 'https://tankionline.com/play/?session=secret'
  });
  const report = diagnostics.report();
  assert.match(report, /CAMERA_INCOMPATIBLE/);
  assert.match(report, /pitch_0\.update_dleff0\$/);
  assert.match(report, /followCamera_0/);
  for (const secret of ['PRIVATE_PLAYER', '31415926', 'SECRET_TOKEN_123', 'person@example.com',
    'session=secret']) {
    assert.ok(!report.includes(secret), `report leaked ${secret}`);
  }
  assert.match(report, /<hidden field>/);
  assert.ok(!report.includes('rawGame')); // Unexpected log fields are dropped altogether.
});

test('diagnostic log has a bounded size and scrubs error URLs', () => {
  const diagnostics = createDiagnostics({ location: { hostname: 'tankionline.com' }, console: {} });
  for (let i = 0; i < 100; i++) diagnostics.record('info', 'TEST_EVENT', { syncs: i });
  const report = JSON.parse(diagnostics.report());
  assert.ok(report.events.length <= 50);
  assert.equal(report.events.at(-1).details.syncs, 99);
  const error = safeError(new Error('Missing field at https://tankionline.com/play/?auth=secret'));
  assert.match(error.message, /<url>/);
  assert.ok(!error.stack.includes('auth=secret'));
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
