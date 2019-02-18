import React from 'react'
import { polyfill as polyfillPromise } from 'es6-promise'
import { mount, render } from 'enzyme'
import sinon from 'sinon'

if (!global.Promise) polyfillPromise()

// INFO - why are we using jest.isolateModules() here?
//
// jest.isolateModules() completely isolates the modules loaded inside the callback
// and reloads them before each test - therefore resetting the local state inside
// the modules. We use this to reset local state inside the react-frontload module
// for each test.
//
// This test file uses the same instance of react-frontload which
// holds local state containing the queues of frontload functions to process
//
// This test does both client and server renders, and certain assumptions
// are made in the code about the runtime environments of client vs server renders,
// namely that they are on separate machines and thus have independent local state.
//
// Doing client renders followed by server renders on the same environment breaks this assumption
// and ends up breaking the code. To work around this, we have three options.
//
// 1) change the order of the tests so that server renders are done first
// and client renders done later. This would happen to work because the server renders leave local state
// in a completely clean state that the client renders can then pick up from and work, whereas the inverse is not true.
// However this is brittle and liable to introduce failures that will be hard to fix in future, as it relies on
// both test order *and* implementation details that might change, and linking either of these things back
// as the cause of tests failing would be very difficult and time consuming if it does happen.
//
// 2) either introduce specific changes to react-frontload to clean up state before each server render
// or expose the ability to clean the local state in the API. I don't like either of these for lots of reasons,
// not least because they have the same implementation-specific brittle nature as in (1), but moreover because
// it means changing the code / API design in the actual library to accomodate tests, which is just clunky
// in my opinion. It would work, but it feels like a hack that would have unintended complexity and
// consequences later on, just like (1).
//
// 3) using Jest itself to simply reload the module entirely before each test.
// I like this option the most because whilst it still makes the tests passing rely on a somewhat obscure
// feature of Jest (though hopefully made less so by the explanation),
// it does let the test framework take care of working around the problem
// instead of the react-frontload code. I like the fact that if there's a test-mode workaround
// for 'fixing' local state so that it works for tests, that that workaround should live at the level
// of the test framework, and the code itself should not have to know or care about this 'shared'
// client/server test runtime environment it needs to work in.

// yes this is clunky, but jest.resetModules() does not work with import syntax because
// you have to manually re-import modules at runtime after calling jest.resetModules()
let { frontloadServerRender, frontloadConnect, Frontload } = require('../src/index')

const resetReactFrontloadModule = () => {
  jest.resetModules()

  // have to manually reload the module after resetting modules
  let reloadedReactFrontloadModule = require('../src/index')
  frontloadServerRender = reloadedReactFrontloadModule.frontloadServerRender
  frontloadConnect = reloadedReactFrontloadModule.frontloadConnect
  Frontload = reloadedReactFrontloadModule.Frontload
}

const mockApiCall = ({ value, delay, fail, log }) => {
  const promise = new Promise((resolve, reject) => {
    setTimeout(() => {
      // for debugging tests
      if (log) {
        console.log(`called mock API with data [${value.data}] log message [${log}]`)
      }

      if (fail) {
        reject(fail)
      } else {
        resolve(value)
      }
    }, delay || 0)
  })
  MOCK_API_PROMISES.push(promise)

  return promise
}

// some random latency for mock api calls -
// not enough to noticably slow down tests but enough to simulate true async conditions
// for frontload
const randomLatency = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const sinonSandbox = sinon.createSandbox()

const MockApi = {
  getA: sinonSandbox.spy((id, mockRestricted, log) => (
    mockApiCall({
      value: { id, data: `a ${id}` },
      delay: randomLatency(200, 500),
      fail: mockRestricted && 401,
      log
    })
  )),
  getB: sinonSandbox.spy((id, mockRestricted, log) => (
    mockApiCall({
      value: { id, data: `b ${id}` },
      delay: randomLatency(200, 500),
      fail: mockRestricted && 401,
      log
    })
  )),
  getC: sinonSandbox.spy((id, mockRestricted, log) => (
    mockApiCall({
      value: { id, data: `c ${id}` },
      delay: randomLatency(200, 500),
      fail: mockRestricted && 401,
      log
    })
  ))
}

// used to run tests deterministically and without resorting to 'waits'
// with this referenced to all promises generated by the mock api we can we know
// when mock api calls have finished following a client render,
// so that a subsequent render can be run knowing that the store is populated with the
// data from the mock api calls
let MOCK_API_PROMISES

beforeEach(() => {
  MOCK_API_PROMISES = []
  sinonSandbox.reset()

  // see comments above
  resetReactFrontloadModule()
})

const Leaf = (props) => (
  <div className='leaf' >
    {props.value ? props.value.data : 'loading...'}
  </div>
)

const Parent = (props) => (
  <div className='parent' >
    <Leaf value={props.value} />
    {props.children}
  </div>
)

const addEntityToStore = (store, type) => (entity) => {
  store[type][entity.id] = entity

  return entity
}

const addEntityFailedToLoadToStore = (store, type, entityId) => () => {
  store[type][entityId] = { data: 'failed to load...' }
}

const buildCleanStore = () => ({ a: {}, b: {}, c: {} })

const frontloads = {
  component1: (props) => (
    MockApi.getA(props.entityId, props.mockRestrictedEntity, props.log)
      .then(addEntityToStore(props.store, 'a'))
      .catch(addEntityFailedToLoadToStore(props.store, 'a', props.entityId))
  ),
  component2: (props) => (
    MockApi.getB(props.entityId, props.mockRestrictedEntity, props.log)
      .then(addEntityToStore(props.store, 'b'))
      .catch(addEntityFailedToLoadToStore(props.store, 'b', props.entityId))
  ),
  component3: (props) => (
    MockApi.getC(props.entityId, props.mockRestrictedEntity, props.log)
      .then(addEntityToStore(props.store, 'c'))
      .catch(addEntityFailedToLoadToStore(props.store, 'c', props.entityId))
  )
}

const Component1 = frontloadConnect(frontloads.component1, { onMount: true, onUpdate: true })((props) => (
  <Parent value={props.store.a[props.entityId]}>
    {props.onlyRenderChildrenWhenDataLoaded // enable this prop to test nested frontload components
      ? props.store.a[props.entityId]
        ? props.children
        : <div className='loading-data'>data loading from frontload function</div>
      : props.children
    }
  </Parent>
))

const Component2 = frontloadConnect(frontloads.component2, { onMount: true, onUpdate: true })((props) => (
  <Parent value={props.store.b[props.entityId]}>
    {props.children}
  </Parent>
))

const Component3 = frontloadConnect(frontloads.component3, { onMount: true, onUpdate: true })((props) => (
  <Leaf value={props.store.c[props.entityId]} />
))

const Component2WithFrontloadOnlyFiringOnUpdate = frontloadConnect(frontloads.component2, { onMount: false, onUpdate: true })((props) => (
  <Parent value={props.store.b[props.entityId]}>
    {props.children}
  </Parent>
))

const Component3WithFrontloadOnlyFiringOnMount = frontloadConnect(frontloads.component3, { onMount: true, onUpdate: false })((props) => (
  <Leaf value={props.store.c[props.entityId]} />
))

const Component3WithNoServerRender = frontloadConnect(frontloads.component3, { noServerRender: true })((props) => (
  <Leaf value={props.store.c[props.entityId]} />
))

const assertDomStructureIsAsExpected = (rendered) => {
  expect(rendered.find(Component1)).toHaveLength(1)
  expect(rendered.find(Component2)).toHaveLength(1)
  expect(rendered.find(Component3)).toHaveLength(2)

  expect(rendered.find(Parent)).toHaveLength(2)
  expect(rendered.find(Leaf)).toHaveLength(4)
}

const assertServerRenderedMarkupStructureIsAsExpected = (rendered) => {
  expect(rendered.find('div.parent')).toHaveLength(2)
  expect(rendered.find('div.leaf')).toHaveLength(4)
}

const assertLoadersAreRendered = (rendered) => {
  expect(rendered.find(Leaf).at(0).text()).toBe('loading...')
  expect(rendered.find(Leaf).at(1).text()).toBe('loading...')
  expect(rendered.find(Leaf).at(2).text()).toBe('loading...')
  expect(rendered.find(Leaf).at(3).text()).toBe('loading...')
}

const assertLoadersAreRenderedOnServer = (serverRenderedMarkup) => {
  expect(serverRenderedMarkup.find('div.leaf').eq(0).text()).toBe('loading...')
  expect(serverRenderedMarkup.find('div.leaf').eq(1).text()).toBe('loading...')
  expect(serverRenderedMarkup.find('div.leaf').eq(2).text()).toBe('loading...')
  expect(serverRenderedMarkup.find('div.leaf').eq(3).text()).toBe('loading...')
}

const assertStoreIsPopulated = (store) => {
  expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
  expect(store.b['3']).toEqual({ id: '3', data: 'b 3' })
  expect(store.c['2']).toEqual({ id: '2', data: 'c 2' })
  expect(store.c['4']).toEqual({ id: '4', data: 'c 4' })
}

const assertStoreIsEmpty = (store) => {
  expect(store.a['1']).toBeUndefined()
  expect(store.b['3']).toBeUndefined()
  expect(store.c['2']).toBeUndefined()
  expect(store.c['4']).toBeUndefined()
}

const assertStoreIsPopulatedIncludingFailures = (store) => {
  expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
  expect(store.b['3']).toEqual({ data: 'failed to load...' })
  expect(store.c['2']).toEqual({ data: 'failed to load...' })
  expect(store.c['4']).toEqual({ id: '4', data: 'c 4' })
}

const assertDataFromStoreIsRendered = (rendered) => {
  expect(rendered.find(Leaf).at(0).text()).toBe('a 1')
  expect(rendered.find(Leaf).at(1).text()).toBe('c 2')
  expect(rendered.find(Leaf).at(2).text()).toBe('b 3')
  expect(rendered.find(Leaf).at(3).text()).toBe('c 4')
}

const assertDataFromStoreIsRenderedOnServer = (serverRenderedMarkup) => {
  expect(serverRenderedMarkup.find('div.leaf').eq(0).text()).toBe('a 1')
  expect(serverRenderedMarkup.find('div.leaf').eq(1).text()).toBe('c 2')
  expect(serverRenderedMarkup.find('div.leaf').eq(2).text()).toBe('b 3')
  expect(serverRenderedMarkup.find('div.leaf').eq(3).text()).toBe('c 4')
}

const assertDataFromStoreIsRenderedIncludingFailures = (rendered) => {
  expect(rendered.find(Leaf).at(0).text()).toBe('a 1')
  expect(rendered.find(Leaf).at(1).text()).toBe('failed to load...')
  expect(rendered.find(Leaf).at(2).text()).toBe('failed to load...')
  expect(rendered.find(Leaf).at(3).text()).toBe('c 4')
}

const assertDataFromStoreIsRenderedOnServerIncludingFailures = (serverRenderedMarkup) => {
  expect(serverRenderedMarkup.find('div.leaf').eq(0).text()).toBe('a 1')
  expect(serverRenderedMarkup.find('div.leaf').eq(1).text()).toBe('failed to load...')
  expect(serverRenderedMarkup.find('div.leaf').eq(2).text()).toBe('failed to load...')
  expect(serverRenderedMarkup.find('div.leaf').eq(3).text()).toBe('c 4')
}

test('v0.0.1: Client render of <App /> with all mock api call promises resolved', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  // Frontload will not run on the first render on the client by default,
  // because it is assumed server rendering is being used
  //
  // Frontload only runs from the first update onwards, when props have changed and data may need to
  // be reloaded (of course, whether or not this is the case is entirely up to the frontload fn implementation(s))
  //
  // So, do a first render just to get it done!
  const firstRender = mount(<App />)

  assertDomStructureIsAsExpected(firstRender)
  assertLoadersAreRendered(firstRender)
  assertStoreIsEmpty(store)

  // Now, force a first update to get frontload to run
  const secondRender = firstRender.update()

  assertDomStructureIsAsExpected(secondRender)
  assertLoadersAreRendered(secondRender)

  // Wait until all mock api calls have completed, then force a second update to render
  // with the content now loaded into the store from the mock api
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const thirdRender = secondRender.update()

    assertDomStructureIsAsExpected(thirdRender)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRendered(thirdRender)
  })
})

test('v0.0.1: Client render of <App /> with 2 mock api call promises resolved and 2 rejected', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} mockRestrictedEntity />
        <Component2 entityId='3' store={store} mockRestrictedEntity >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  const firstRender = mount(<App />)
  assertDomStructureIsAsExpected(firstRender)
  assertLoadersAreRendered(firstRender)
  assertStoreIsEmpty(store)

  const secondRender = firstRender.update()
  assertDomStructureIsAsExpected(secondRender)
  assertLoadersAreRendered(secondRender)
  assertStoreIsEmpty(store)

  // this is just used to continue after all the mock api responses have returned
  // one promise will be rejected, hence the mapping all promises to ignore catch
  const allPromisesResolved =
    Promise.all([ ...MOCK_API_PROMISES ].map((promise) => promise.catch(() => true)))

  return allPromisesResolved.then(() => {
    const thirdRender = secondRender.update()

    assertDomStructureIsAsExpected(thirdRender)
    assertStoreIsPopulatedIncludingFailures(store)
    assertDataFromStoreIsRenderedIncludingFailures(thirdRender)
  })
})

test('v0.0.1: Client render of <App /> with server rendering configured off globally', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} noServerRender >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  // every frontload function will run on the first render on the client,
  // because the global noServerRendering configuration is set
  const firstRender = mount(<App />)

  assertDomStructureIsAsExpected(firstRender)
  assertLoadersAreRendered(firstRender)
  assertStoreIsEmpty(store)

  // Wait until all mock api calls have completed, then force a second update to render
  // with the content now loaded into the store from the mock api
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const secondRender = firstRender.update()

    assertDomStructureIsAsExpected(secondRender)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRendered(secondRender)
  })
})

test('v0.0.1: Client render of <App /> with server rendering configured off for one component', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3WithNoServerRender entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  // Frontload will run on the first render only for Component3WithNoServerRender
  // since it is the only component with noServerRendering === true
  const firstRender = mount(<App />)

  // assert dom structure
  expect(firstRender.find(Component1)).toHaveLength(1)
  expect(firstRender.find(Component2)).toHaveLength(1)
  expect(firstRender.find(Component3)).toHaveLength(1)
  expect(firstRender.find(Component3WithNoServerRender)).toHaveLength(1)
  expect(firstRender.find(Parent)).toHaveLength(2)
  expect(firstRender.find(Leaf)).toHaveLength(4)

  assertLoadersAreRendered(firstRender)
  assertStoreIsEmpty(store)

  // Wait until the mock api call has completed for Component3WithNoServerRender,
  // then force an update to render the loaded data for that component, and execute
  // the frontloads for all the other components (now that we are past the first render)
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const secondRender = firstRender.update()

    // assert dom structure
    expect(secondRender.find(Component1)).toHaveLength(1)
    expect(secondRender.find(Component2)).toHaveLength(1)
    expect(secondRender.find(Component3)).toHaveLength(1)
    expect(secondRender.find(Component3WithNoServerRender)).toHaveLength(1)
    expect(secondRender.find(Parent)).toHaveLength(2)
    expect(secondRender.find(Leaf)).toHaveLength(4)

    // assert store is only populated in the store for Component3WithNoServerRender
    expect(store.a['1']).toBeUndefined()
    expect(store.b['3']).toBeUndefined()
    expect(store.c['2']).toBeUndefined()
    expect(store.c['4']).toEqual({ id: '4', data: 'c 4' })

    // assert data is only rendered for Component3WithNoServerRender
    expect(secondRender.find(Leaf).at(0).text()).toBe('loading...')
    expect(secondRender.find(Leaf).at(1).text()).toBe('loading...')
    expect(secondRender.find(Leaf).at(2).text()).toBe('loading...')
    expect(secondRender.find(Leaf).at(3).text()).toBe('c 4')

    return Promise.all([ ...MOCK_API_PROMISES ]).then(() => secondRender)
  })
  // Wait until all mock api calls have completed, then force a third update to render
  // with the content now loaded into the store from the mock api
    .then((secondRender) => {
      const thirdRender = secondRender.update()

      // assert dom structure
      expect(thirdRender.find(Component1)).toHaveLength(1)
      expect(thirdRender.find(Component2)).toHaveLength(1)
      expect(thirdRender.find(Component3)).toHaveLength(1)
      expect(thirdRender.find(Component3WithNoServerRender)).toHaveLength(1)
      expect(thirdRender.find(Parent)).toHaveLength(2)
      expect(thirdRender.find(Leaf)).toHaveLength(4)

      assertStoreIsPopulated(store)
      assertDataFromStoreIsRendered(thirdRender)
    })
})

test('v0.0.1: Client render of <App /> with server rendering configured off globally', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} noServerRender >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  // every frontload function will run on the first render on the client,
  // because the global noServerRendering configuration is set
  const firstRender = mount(<App />)

  assertDomStructureIsAsExpected(firstRender)
  assertLoadersAreRendered(firstRender)
  assertStoreIsEmpty(store)

  // Wait until all mock api calls have completed, then force a second update to render
  // with the content now loaded into the store from the mock api
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const secondRender = firstRender.update()

    assertDomStructureIsAsExpected(secondRender)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRendered(secondRender)
  })
})

test('v0.0.4: Client render of <App /> with nested frontload components', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} >
      {/*  onlyRenderChildrenWhenDataLoaded prop means that children only load once Component1's frontload has resolved with data */}
      <Component1 entityId='1' store={store} onlyRenderChildrenWhenDataLoaded >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  // Frontload will not run on the first render on the client by default,
  // because it is assumed server rendering is being used
  //
  // Frontload only runs from the first update onwards, when props have changed and data may need to
  // be reloaded (of course, whether or not this is the case is entirely up to the frontload fn implementation(s))
  //
  // So, do a first render just to get it done!
  const firstRender = mount(<App />)

  expect(firstRender.find(Component1)).toHaveLength(1)
  expect(firstRender.find(Component2)).toHaveLength(0)
  expect(firstRender.find(Component3)).toHaveLength(0)
  expect(firstRender.find(Parent)).toHaveLength(1)
  expect(firstRender.find(Leaf)).toHaveLength(1)

  expect(firstRender.find('div.loading-data').at(0).text()).toBe('data loading from frontload function')
  expect(firstRender.find(Leaf).at(0).text()).toBe('loading...')

  assertStoreIsEmpty(store)

  // Now, force a first update to get frontload to run
  const secondRender = firstRender.update()

  expect(secondRender.find(Component1)).toHaveLength(1)
  expect(secondRender.find(Component2)).toHaveLength(0)
  expect(secondRender.find(Component3)).toHaveLength(0)
  expect(secondRender.find(Parent)).toHaveLength(1)
  expect(secondRender.find(Leaf)).toHaveLength(1)

  expect(firstRender.find('div.loading-data').at(0).text()).toBe('data loading from frontload function')
  expect(secondRender.find(Leaf).at(0).text()).toBe('loading...')

  // Wait until all mock api calls have completed, then force another update to render
  // with the content now loaded into the store from the mock api and start the nested frontload
  // components rendering
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const thirdRender = secondRender.update()

    expect(thirdRender.find(Component1)).toHaveLength(1)
    expect(thirdRender.find(Component2)).toHaveLength(1)
    expect(thirdRender.find(Component3)).toHaveLength(2)
    expect(thirdRender.find(Parent)).toHaveLength(2)
    expect(thirdRender.find(Leaf)).toHaveLength(4)

    expect(thirdRender.find(Leaf).at(0).text()).toBe('a 1')
    expect(thirdRender.find(Leaf).at(1).text()).toBe('loading...')
    expect(thirdRender.find(Leaf).at(2).text()).toBe('loading...')
    expect(thirdRender.find(Leaf).at(3).text()).toBe('loading...')

    expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
    expect(store.b['3']).toBeUndefined()
    expect(store.c['2']).toBeUndefined()
    expect(store.c['4']).toBeUndefined()

    // wait until the now rendering frontloads' mock api calls have completed, then force another update to render
    // with the content now loaded into the store from the mock api
    return Promise.all([ ...MOCK_API_PROMISES ]).then(() => thirdRender)
  }).then((thirdRender) => {
    const fourthRender = thirdRender.update()

    assertDomStructureIsAsExpected(fourthRender)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRendered(fourthRender)
  })
})

test('v0.0.1: Server render of <App /> with all mock api call promises resolved', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  return frontloadServerRender(() => (
    render(<App />)
  )).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(1)
    expect(MockApi.getB.withArgs('3').callCount).toBe(1)
    expect(MockApi.getC.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(1)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRenderedOnServer(serverRenderedMarkup)
  })
})

test('v0.0.1: Server render of <App /> with 2 mock api call promises resolved and 2 rejected', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} mockRestrictedEntity />
        <Component2 entityId='3' store={store} mockRestrictedEntity >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  return frontloadServerRender(() => (
    render(<App />)
  )).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(1)
    expect(MockApi.getB.withArgs('3', true).callCount).toBe(1)
    expect(MockApi.getC.withArgs('2', true).callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(1)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsPopulatedIncludingFailures(store)
    assertDataFromStoreIsRenderedOnServerIncludingFailures(serverRenderedMarkup)
  })
})

test('v0.0.1: Server render of <App /> with server rendering configured off globally', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer noServerRender >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  return frontloadServerRender(() => (
    render(<App />)
  )).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(0)
    expect(MockApi.getB.withArgs('3').callCount).toBe(0)
    expect(MockApi.getC.withArgs('2').callCount).toBe(0)
    expect(MockApi.getC.withArgs('4').callCount).toBe(0)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsEmpty(store)
    assertLoadersAreRenderedOnServer(serverRenderedMarkup)
  })
})

test('v0.0.1: Server render of <App /> with server rendering configured off for one component', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer >
      <Component1 entityId='1' store={store} >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3WithNoServerRender entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  return frontloadServerRender(() => (
    render(<App />)
  )).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(1)
    expect(MockApi.getB.withArgs('3').callCount).toBe(1)
    expect(MockApi.getC.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(0)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)

    // assert all data is populated in store apart from the data loaded by Component3WithNoServerRender
    expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
    expect(store.b['3']).toEqual({ id: '3', data: 'b 3' })
    expect(store.c['2']).toEqual({ id: '2', data: 'c 2' })
    expect(store.c['4']).toBeUndefined()

    // assert all data is rendered apart from the data for Component3WithNoServerRender, which still shows loading
    expect(serverRenderedMarkup.find('div.leaf').eq(0).text()).toBe('a 1')
    expect(serverRenderedMarkup.find('div.leaf').eq(1).text()).toBe('c 2')
    expect(serverRenderedMarkup.find('div.leaf').eq(2).text()).toBe('b 3')
    expect(serverRenderedMarkup.find('div.leaf').eq(3).text()).toBe('loading...')
  })
})

test('v0.0.2: Client render of <App /> with frontloads firing api calls based on lifecycle phase', () => {
  const store = buildCleanStore()

  const App = () => (
    <Frontload isServer={false} noServerRender >
      <Component1 entityId='1' store={store} >
        <Component2WithFrontloadOnlyFiringOnUpdate entityId='2' store={store} >
          <Component3WithFrontloadOnlyFiringOnMount entityId='3' store={store} />
        </Component2WithFrontloadOnlyFiringOnUpdate>
      </Component1>
    </Frontload>
  )

  const firstRender = mount(<App />)

  // After first render:
  // Component 1 frontload should run (configured to run on both mount and update)
  // Component 2 frontload should NOT run (configured to only run on update - this is a mount)
  // Component 3 frontload should run (configured to run only on mount - this is the mount)
  expect(MockApi.getA.withArgs('1').callCount).toBe(1)
  expect(MockApi.getB.withArgs('2').callCount).toBe(0)
  expect(MockApi.getC.withArgs('3').callCount).toBe(1)

  // Assert content is loading (frontload promises, from those that ran, are still in flight at this stage)
  expect(firstRender.find(Component1)).toHaveLength(1)
  expect(firstRender.find(Component2WithFrontloadOnlyFiringOnUpdate)).toHaveLength(1)
  expect(firstRender.find(Component3WithFrontloadOnlyFiringOnMount)).toHaveLength(1)
  expect(firstRender.find(Parent)).toHaveLength(2)
  expect(firstRender.find(Leaf)).toHaveLength(3)

  expect(firstRender.find(Leaf).at(0).text()).toBe('loading...')
  expect(firstRender.find(Leaf).at(1).text()).toBe('loading...')
  expect(firstRender.find(Leaf).at(2).text()).toBe('loading...')

  assertStoreIsEmpty(store)

  // Wait until all mock api calls have completed, then force an update to render the loaded data
  return Promise.all([ ...MOCK_API_PROMISES ]).then(() => {
    const secondRender = firstRender.update()

    // after second render:
    // Component 1 frontload should run again (configured to run on both mount and update)
    // Component 2 frontload should run (configured to only run on update - this is an update)
    // Component 3 frontload should NOT run (configured to run only on mount - this is an update)
    expect(MockApi.getA.withArgs('1').callCount).toBe(2)
    expect(MockApi.getB.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('3').callCount).toBe(1)

    // Assert loaded content is rendered, and component 2 which still has its frontload promise in flight shows loading
    expect(firstRender.find(Component1)).toHaveLength(1)
    expect(firstRender.find(Component2WithFrontloadOnlyFiringOnUpdate)).toHaveLength(1)
    expect(firstRender.find(Component3WithFrontloadOnlyFiringOnMount)).toHaveLength(1)
    expect(firstRender.find(Parent)).toHaveLength(2)
    expect(firstRender.find(Leaf)).toHaveLength(3)

    expect(firstRender.find(Leaf).at(0).text()).toBe('a 1')
    expect(firstRender.find(Leaf).at(1).text()).toBe('loading...') // Component 2's frontload only ran on second render, promise still in flight, data still loading
    expect(firstRender.find(Leaf).at(2).text()).toBe('c 3')

    expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
    expect(store.b['2']).toBeUndefined() // Component 2's frontload only ran on second render, promise still in flight, data still loading
    expect(store.c['3']).toEqual({ id: '3', data: 'c 3' })

    return Promise.all([ ...MOCK_API_PROMISES ]).then(() => secondRender)
  })
    .then((secondRender) => {
      const thirdRender = secondRender.update()

      // after third render:
      // Component 1 frontload should run again (configured to run on both mount and update)
      // Component 2 frontload should run again (configured to only run on update - this is an update)
      // Component 3 frontload should NOT run (configured to run only on mount - this is an update)
      expect(MockApi.getA.withArgs('1').callCount).toBe(3)
      expect(MockApi.getB.withArgs('2').callCount).toBe(2)
      expect(MockApi.getC.withArgs('3').callCount).toBe(1)

      // Assert all content is loaded and rendered now
      expect(thirdRender.find(Component1)).toHaveLength(1)
      expect(thirdRender.find(Component2WithFrontloadOnlyFiringOnUpdate)).toHaveLength(1)
      expect(thirdRender.find(Component3WithFrontloadOnlyFiringOnMount)).toHaveLength(1)
      expect(thirdRender.find(Parent)).toHaveLength(2)
      expect(thirdRender.find(Leaf)).toHaveLength(3)

      expect(thirdRender.find(Leaf).at(0).text()).toBe('a 1')
      expect(thirdRender.find(Leaf).at(1).text()).toBe('b 2')
      expect(thirdRender.find(Leaf).at(2).text()).toBe('c 3')

      expect(store.a['1']).toEqual({ id: '1', data: 'a 1' })
      expect(store.b['2']).toEqual({ id: '2', data: 'b 2' })
      expect(store.c['3']).toEqual({ id: '3', data: 'c 3' })
    })
})

test.only('v0.0.1: Server render of <App /> with nested frontload components', async () => {
  let store = buildCleanStore()

  const App = () => (
    <Frontload isServer >
      {/*  onlyRenderChildrenWhenDataLoaded prop means that children only load once Component1's frontload has resolved with data */}
      <Component1 entityId='1' store={store} onlyRenderChildrenWhenDataLoaded >
        <Component3 entityId='2' store={store} />
        <Component2 entityId='3' store={store} >
          <Component3 entityId='4' store={store} />
        </Component2>
      </Component1>
    </Frontload>
  )

  await frontloadServerRender(() => (
    render(<App />)
  ), {
    maxNestedFrontloadComponents: 2 // the exact level required, no more
  }).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(2) // called on 1st and 2nd renders
    expect(MockApi.getB.withArgs('3').callCount).toBe(1) // called only on 2nd render
    expect(MockApi.getC.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(1)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRenderedOnServer(serverRenderedMarkup)
  })

  // reset the mock api call counters and reset the store
  sinonSandbox.reset()
  store = buildCleanStore()

  await frontloadServerRender(() => (
    render(<App />)
  ), {
    maxNestedFrontloadComponents: 3 // one more than required
  }).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(2) // called on 1st and 2nd renders
    expect(MockApi.getB.withArgs('3').callCount).toBe(1) // called only on 2nd render
    expect(MockApi.getC.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(1)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRenderedOnServer(serverRenderedMarkup)
  })

  // reset the mock api call counters and reset the store
  sinonSandbox.reset()
  store = buildCleanStore()

  await frontloadServerRender(() => (
    render(<App />)
  ), {
    maxNestedFrontloadComponents: 100000000 // much more than required, almost unlimited
  }).then((serverRenderedMarkup) => {
    expect(MockApi.getA.withArgs('1').callCount).toBe(2) // called on 1st and 2nd renders
    expect(MockApi.getB.withArgs('3').callCount).toBe(1) // called only on 2nd render
    expect(MockApi.getC.withArgs('2').callCount).toBe(1)
    expect(MockApi.getC.withArgs('4').callCount).toBe(1)

    assertServerRenderedMarkupStructureIsAsExpected(serverRenderedMarkup)
    assertStoreIsPopulated(store)
    assertDataFromStoreIsRenderedOnServer(serverRenderedMarkup)
  })
})
